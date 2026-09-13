/*
 * Le helper vocal de Noted : l'oreille et la bouche de l'assistant.
 *
 * Un petit programme a part, ecrit en Swift parce que les deux moteurs qu'il
 * faut sont ceux de macOS et n'existent nulle part ailleurs : la transcription
 * hors ligne du framework Speech (macOS 26, modele francais deja installe) et
 * les voix du systeme par AVSpeechSynthesizer. Rien ne sort du Mac.
 *
 * Il parle au processus principal en lignes JSON : une commande par ligne sur
 * l'entree standard, un evenement par ligne sur la sortie. Le protocole est
 * decrit une fois pour toutes dans helper.ts, qui est son seul interlocuteur.
 *
 * Pourquoi lui et pas l'API du navigateur : la synthese de Chromium ne dit
 * jamais quel mot elle prononce sur macOS, alors qu'AVSpeechSynthesizer le
 * dit a chaque mot — c'est ce qui permet de savoir, a la coupure, ce que
 * l'utilisateur a reellement entendu. Et le micro passe par le traitement
 * vocal du systeme, qui efface de l'entree ce que les haut-parleurs jouent :
 * sans lui, l'assistant s'entendrait parler et se couperait lui-meme.
 */

import Foundation
import Speech
import AVFoundation

// MARK: - La sortie : une ligne JSON par evenement

final class Sortie {
    static let partagee = Sortie()
    private let file = DispatchQueue(label: "noted.voix.sortie")

    func emettre(_ objet: [String: Any]) {
        file.async {
            guard let data = try? JSONSerialization.data(withJSONObject: objet),
                  var ligne = String(data: data, encoding: .utf8) else { return }
            ligne.append("\n")
            FileHandle.standardOutput.write(ligne.data(using: .utf8)!)
        }
    }

    func erreur(_ message: String) {
        emettre(["ev": "erreur", "message": message])
    }
}

func emettre(_ objet: [String: Any]) { Sortie.partagee.emettre(objet) }
// MARK: - Le lecteur

/**
 * La voix de l'assistant arrive toute faite : Kokoro la fabrique dans un
 * processus a part et depose un fichier. Le role du lecteur est de l'enchainer
 * sans couture, de dire a quel mot il en est, et de se taire sur-le-champ.
 *
 * Chaque morceau porte les instants de ses mots. On ne les devine pas : ils
 * viennent des durees que le modele a rendues phoneme par phoneme. Le lecteur
 * suit la position reelle de la tete de lecture et annonce chaque mot quand il
 * est atteint — c'est ce qui permet, a la coupure, de savoir ce qui a ete
 * entendu et non ce qui avait ete prevu.
 */
final class Lecteur {
    private let moteur = AVAudioEngine()
    private let lecteur = AVAudioPlayerNode()
    private var branche = false
    private var format: AVAudioFormat?

    /** Un morceau en file : ou il commence dans le flux, et ou en sont ses mots. */
    private struct Morceau {
        let id: String
        let chemin: String
        let debut: AVAudioFramePosition
        let longueur: AVAudioFramePosition
        let taux: Double
        /** Les mots, chacun avec l'instant ou il se prononce. */
        var jalons: [(quand: Double, position: Int, longueur: Int)]
        var suivant = 0
        var commence = false
    }

    private var file: [Morceau] = []
    private var cumul: AVAudioFramePosition = 0
    private var horloge: DispatchSourceTimer?
    /** Le dernier mot annonce, pour le dire a celui qui coupe. */
    private var dernierMot: Int?
    private var enCours: String?

    func jouer(id: String, chemin: String, jalons: [[String: Any]]) {
        do {
            let fichier = try AVAudioFile(forReading: URL(fileURLWithPath: chemin))
            let formatFichier = fichier.processingFormat
            if !branche || format?.sampleRate != formatFichier.sampleRate {
                if branche { moteur.disconnectNodeOutput(lecteur) } else { moteur.attach(lecteur) }
                moteur.connect(lecteur, to: moteur.mainMixerNode, format: formatFichier)
                format = formatFichier
                branche = true
            }
            if !moteur.isRunning {
                moteur.prepare()
                try moteur.start()
            }

            let morceau = Morceau(
                id: id,
                chemin: chemin,
                debut: cumul,
                longueur: fichier.length,
                taux: formatFichier.sampleRate,
                jalons: jalons.compactMap { jalon in
                    guard let quand = jalon["quand"] as? Int,
                          let position = jalon["position"] as? Int,
                          let longueur = jalon["longueur"] as? Int else { return nil }
                    return (Double(quand) / 1000, position, longueur)
                }
            )
            cumul += fichier.length
            file.append(morceau)
            lecteur.scheduleFile(fichier, at: nil)
            if !lecteur.isPlaying { lecteur.play() }
            suivre()
        } catch {
            Sortie.partagee.erreur("lecture : \(error.localizedDescription)")
            emettre(["ev": "fin", "id": id])
        }
    }

    /** Ou en est la tete de lecture, en images depuis le debut de la file. */
    private func position() -> AVAudioFramePosition? {
        guard let noeud = lecteur.lastRenderTime, let temps = lecteur.playerTime(forNodeTime: noeud) else { return nil }
        return temps.sampleTime
    }

    private func suivre() {
        guard horloge == nil else { return }
        let minuteur = DispatchSource.makeTimerSource(queue: .main)
        // Vingt-cinq millisecondes : plus fin que l'oreille ne distingue deux
        // mots, et assez large pour ne rien couter.
        minuteur.schedule(deadline: .now(), repeating: .milliseconds(25))
        minuteur.setEventHandler { [weak self] in self?.avancer() }
        horloge = minuteur
        minuteur.resume()
    }

    private func avancer() {
        guard let position = position() else { return }
        while var morceau = file.first {
            if !morceau.commence {
                morceau.commence = true
                enCours = morceau.id
                dernierMot = nil
                emettre(["ev": "debut", "id": morceau.id])
            }
            // Les mots atteints depuis le dernier tour.
            while morceau.suivant < morceau.jalons.count {
                let jalon = morceau.jalons[morceau.suivant]
                let quand = morceau.debut + AVAudioFramePosition(jalon.quand * morceau.taux)
                if position < quand { break }
                morceau.suivant += 1
                dernierMot = jalon.position
                emettre(["ev": "mot", "id": morceau.id, "debut": jalon.position, "longueur": jalon.longueur])
            }
            if position < morceau.debut + morceau.longueur {
                file[0] = morceau
                return
            }
            file.removeFirst()
            try? FileManager.default.removeItem(atPath: morceau.chemin)
            enCours = nil
            emettre(["ev": "fin", "id": morceau.id])
        }
        // Plus rien a dire : on remet la tete de lecture a zero, pour que le
        // prochain morceau reparte d'une horloge propre.
        horloge?.cancel()
        horloge = nil
        lecteur.stop()
        cumul = 0
        moteur.stop()
    }

    /** Se taire sur-le-champ, et dire sur quel mot. */
    func stop() {
        let id = enCours
        let mot = dernierMot
        horloge?.cancel()
        horloge = nil
        lecteur.stop()
        for morceau in file { try? FileManager.default.removeItem(atPath: morceau.chemin) }
        file.removeAll()
        cumul = 0
        enCours = nil
        dernierMot = nil
        moteur.stop()
        var evenement: [String: Any] = ["ev": "arret"]
        if let id { evenement["id"] = id }
        if let mot { evenement["mot"] = mot }
        emettre(evenement)
    }
}

// MARK: - L'oreille

/**
 * Le micro reste ouvert tant que le mode est actif — c'est ce qui permet de
 * couper l'assistant a la voix sans geste. L'analyseur tourne en continu et
 * rend ses resultats au fil de l'eau : « volatils » tant qu'il hesite,
 * « final » quand il tranche. C'est le processus principal qui decide de ce
 * qu'il en fait.
 */
@available(macOS 26.0, *)
final class Oreille {
    private let moteur = AVAudioEngine()
    private var analyseur: SpeechAnalyzer?
    private var entree: AsyncStream<AnalyzerInput>.Continuation?
    private var format: AVAudioFormat?
    private var lecteur: Task<Void, Never>?
    private var observateur: NSObjectProtocol?
    private(set) var ouverte = false
    /** Tampons recus du micro depuis l'ouverture — pour le diagnostic. */
    var tampons = 0
    /** Le plus haut niveau livre a l'analyseur : un zero parfait trahit une conversion perdue. */
    var niveau: Float = 0

    /** Ou en est l'oreille : le moteur tourne-t-il, le micro livre-t-il, et du son y passe-t-il ? */
    func diagnostic() {
        emettre([
            "ev": "diagnostic", "moteur": moteur.isRunning, "tampons": tampons,
            "ouverte": ouverte, "niveau": Double(niveau)
        ])
        niveau = 0
    }

    /**
     * `annulationEcho` ne se desactive que pour les tests : sans elle, le micro
     * entend les haut-parleurs — la voix de l'assistant comme une question
     * jouee par un script —, ce qui permet de mesurer la latence reelle de la
     * transcription sans voix humaine.
     */
    func ouvrir(annulationEcho: Bool = true, rapide: Bool = true) async {
        if ouverte { return }
        do {
            // Sans les options de rapidite, l'analyseur rend ses resultats par
            // fenetres d'une dizaine de secondes d'audio : une phrase tombee en
            // debut de fenetre attend dix secondes. Pour couper l'assistant a
            // la voix, il faut les mots des qu'ils sont dits.
            var rapport: Set<SpeechTranscriber.ReportingOption> = [.volatileResults]
            if rapide { rapport.insert(.fastResults) }
            let transcripteur = SpeechTranscriber(
                locale: Locale(identifier: "fr_FR"),
                transcriptionOptions: [],
                reportingOptions: rapport,
                attributeOptions: []
            )

            // Le modele francais est livre avec macOS mais peut ne pas etre
            // installe : le systeme le telecharge une fois et le garde, comme
            // une langue de dictee.
            if await AssetInventory.status(forModules: [transcripteur]) != .installed,
               let demande = try await AssetInventory.assetInstallationRequest(supporting: [transcripteur]) {
                emettre(["ev": "telechargement", "etat": "debut"])
                try await demande.downloadAndInstall()
                emettre(["ev": "telechargement", "etat": "fin"])
            }

            let analyseur = SpeechAnalyzer(modules: [transcripteur])
            let micro = moteur.inputNode
            // Le traitement vocal du systeme : annulation d'echo, reduction de
            // bruit. C'est lui qui retire de l'entree la voix de l'assistant
            // jouee par les haut-parleurs.
            try micro.setVoiceProcessingEnabled(annulationEcho)
            let formatMicro = micro.outputFormat(forBus: 0)

            guard let formatAnalyse = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcripteur], considering: formatMicro
            ) else {
                Sortie.partagee.erreur("aucun format audio compatible avec la transcription")
                return
            }
            guard let convertisseur = AVAudioConverter(from: formatMicro, to: formatAnalyse) else {
                Sortie.partagee.erreur("conversion audio impossible")
                return
            }
            // Le traitement vocal change la forme de l'entree : sept canaux au
            // lieu d'un, en disposition « discrete » — des canaux sans role
            // declare. Le convertisseur, lui, ne sait mixer vers le mono que
            // des dispositions connues : devant celle-la il ne proteste pas,
            // il rend des images de zeros, et l'analyseur ecoute un silence
            // parfait sans que rien ne le dise. On lui designe donc le canal a
            // prendre : le premier, celui de la voix traitee.
            convertisseur.channelMap = [0]

            let (flux, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            micro.installTap(onBus: 0, bufferSize: 4096, format: formatMicro) { [weak self] tampon, _ in
                self?.tampons += 1
                if let converti = Oreille.convertir(tampon, avec: convertisseur, vers: formatAnalyse) {
                    self?.niveau = max(self?.niveau ?? 0, Oreille.crete(converti))
                    continuation.yield(AnalyzerInput(buffer: converti))
                }
            }

            lecteur = Task {
                do {
                    for try await resultat in transcripteur.results {
                        emettre([
                            "ev": "resultat",
                            "texte": String(resultat.text.characters),
                            "final": resultat.isFinal
                        ])
                    }
                } catch is CancellationError {
                    // Le micro se ferme : c'est nous qui avons annule le lecteur.
                } catch {
                    Sortie.partagee.erreur("transcription : \(error.localizedDescription)")
                }
            }

            try await analyseur.start(inputSequence: flux)
            moteur.prepare()
            try moteur.start()

            // Quand la configuration audio change — la synthese qui ouvre la
            // sortie, un casque branche —, le moteur s'arrete de lui-meme et
            // le micro se tait. On le relance, sinon l'oreille resterait sourde
            // sans rien dire.
            observateur = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: moteur, queue: .main
            ) { [weak self] _ in
                guard let self, self.ouverte, !self.moteur.isRunning else { return }
                do {
                    try self.moteur.start()
                    emettre(["ev": "audio", "relance": true])
                } catch {
                    Sortie.partagee.erreur("micro relance impossible : \(error.localizedDescription)")
                }
            }

            self.analyseur = analyseur
            self.entree = continuation
            self.format = formatAnalyse
            ouverte = true
            emettre(["ev": "micro", "ouvert": true])
        } catch {
            Sortie.partagee.erreur("micro : \(error.localizedDescription)")
        }
    }

    /** Un tampon du micro (48 kHz, plusieurs canaux) vers ce que l'analyseur attend (16 kHz mono). */
    static func convertir(_ tampon: AVAudioPCMBuffer, avec convertisseur: AVAudioConverter, vers format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / tampon.format.sampleRate
        let capacite = AVAudioFrameCount(Double(tampon.frameLength) * ratio) + 32
        guard let sortie = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacite) else { return nil }
        var erreur: NSError?
        var consomme = false
        convertisseur.convert(to: sortie, error: &erreur) { _, statut in
            if consomme {
                statut.pointee = .noDataNow
                return nil
            }
            consomme = true
            statut.pointee = .haveData
            return tampon
        }
        if erreur != nil || sortie.frameLength == 0 { return nil }
        return sortie
    }

    /** Le plus fort echantillon d'un tampon, entre 0 et 1. */
    static func crete(_ tampon: AVAudioPCMBuffer) -> Float {
        guard let donnees = tampon.int16ChannelData, tampon.frameLength > 0 else { return 0 }
        var maximum: Int32 = 0
        for i in 0..<Int(tampon.frameLength) { maximum = max(maximum, abs(Int32(donnees[0][i]))) }
        return Float(maximum) / 32768
    }

    /** Force l'analyseur a trancher ce qu'il tient encore pour volatil. */
    func finaliser() async {
        try? await analyseur?.finalize(through: nil)
    }

    /**
     * Un fichier audio verse dans l'analyseur comme s'il venait du micro. Ne
     * sert qu'a verifier la chaine complete sans voix humaine : avec le
     * traitement vocal actif, tout son joue par les haut-parleurs est efface
     * avant d'atteindre l'analyseur, et rien d'autre ne permet de tester.
     */
    func injecter(chemin: String) async {
        guard let format, let entree else {
            Sortie.partagee.erreur("micro ferme : rien ou injecter")
            return
        }
        do {
            let fichier = try AVAudioFile(forReading: URL(fileURLWithPath: chemin))
            guard let convertisseur = AVAudioConverter(from: fichier.processingFormat, to: format) else {
                Sortie.partagee.erreur("conversion du fichier impossible")
                return
            }
            // D'un seul bloc, et non au rythme du temps reel : verse par
            // morceaux espaces, l'audio s'entrelace avec les tampons du micro
            // et l'analyseur entend une phrase hachee de silences.
            while fichier.framePosition < fichier.length {
                guard let tampon = AVAudioPCMBuffer(pcmFormat: fichier.processingFormat, frameCapacity: 8192) else { break }
                try fichier.read(into: tampon)
                if tampon.frameLength == 0 { break }
                if let converti = Oreille.convertir(tampon, avec: convertisseur, vers: format) {
                    entree.yield(AnalyzerInput(buffer: converti))
                }
            }
            emettre(["ev": "injecte", "chemin": chemin])
        } catch {
            Sortie.partagee.erreur("injection : \(error.localizedDescription)")
        }
    }

    func fermer() async {
        guard ouverte else { return }
        if let observateur { NotificationCenter.default.removeObserver(observateur) }
        observateur = nil
        moteur.inputNode.removeTap(onBus: 0)
        moteur.stop()
        entree?.finish()
        await analyseur?.cancelAndFinishNow()
        lecteur?.cancel()
        analyseur = nil
        entree = nil
        format = nil
        ouverte = false
        emettre(["ev": "micro", "ouvert": false])
    }
}

// MARK: - Les commandes

let lecteur = Lecteur()
var oreille: Oreille? = nil
if #available(macOS 26.0, *) { oreille = Oreille() }

func traiter(_ commande: String, _ objet: [String: Any]) {
    switch commande {
    case "jouer":
        lecteur.jouer(
            id: objet["id"] as? String ?? "",
            chemin: objet["chemin"] as? String ?? "",
            jalons: objet["jalons"] as? [[String: Any]] ?? []
        )
    case "stop":
        lecteur.stop()
    case "ecouter":
        guard let oreille else { Sortie.partagee.erreur("la transcription demande macOS 26"); return }
        let annulationEcho = objet["aec"] as? Bool ?? true
        let rapide = objet["rapide"] as? Bool ?? true
        Task { await oreille.ouvrir(annulationEcho: annulationEcho, rapide: rapide) }
    case "taire":
        Task { await oreille?.fermer() }
    case "finaliser":
        Task { await oreille?.finaliser() }
    case "injecter":
        if let chemin = objet["chemin"] as? String { Task { await oreille?.injecter(chemin: chemin) } }
    case "diagnostic":
        oreille?.diagnostic()
    case "quitter":
        exit(0)
    default:
        Sortie.partagee.erreur("commande inconnue : \(commande)")
    }
}

// L'entree standard est lue sur un fil a part ; chaque commande est traitee
// sur le fil principal, ou vivent le synthetiseur et ses rappels.
DispatchQueue(label: "noted.voix.entree").async {
    while let ligne = readLine(strippingNewline: true) {
        guard let data = ligne.data(using: .utf8),
              let objet = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let commande = objet["cmd"] as? String else { continue }
        DispatchQueue.main.async { traiter(commande, objet) }
    }
    // Entree fermee : le processus principal est parti, on le suit.
    DispatchQueue.main.async { exit(0) }
}

emettre(["ev": "pret", "transcription": oreille != nil])
RunLoop.main.run()
