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

// MARK: - La bouche

/**
 * Une phrase a la fois, dans l'ordre ou elles arrivent. Chaque phrase porte
 * l'identifiant que le processus principal lui a donne : c'est lui qu'on
 * rend dans « debut », « mot », « fin » et « arret », pour qu'il sache de
 * quelle phrase il s'agit sans tenir de compte de son cote.
 */
final class Bouche: NSObject, AVSpeechSynthesizerDelegate {
    private let synthese = AVSpeechSynthesizer()
    /** L'identifiant de chaque phrase en file ou en cours. */
    private var identifiants: [AVSpeechUtterance: String] = [:]
    private var enCours: String?
    /** Position du dernier mot commence dans la phrase en cours. */
    private var dernierMot: Int?
    private var voix: AVSpeechSynthesisVoice? = Bouche.meilleureVoix()
    private var vitesse: Float = 1.0

    private static let CHAUFFE = "#chauffe"

    override init() {
        super.init()
        synthese.delegate = self
    }

    // Les voix francaises, et laquelle prendre quand personne n'a choisi :
    // la meilleure qualite d'abord (une voix amelioree telechargee par
    // l'utilisateur passe devant les compactes), la France devant le Canada,
    // les voix modernes devant les voix Eloquence de synthese formantique.
    static func voixFrancaises() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("fr") }
            .sorted { rang($0) > rang($1) }
    }

    private static func rang(_ voix: AVSpeechSynthesisVoice) -> Int {
        var rang = voix.quality.rawValue * 100
        if voix.language == "fr-FR" { rang += 20 }
        if !voix.identifier.contains("eloquence") { rang += 10 }
        if voix.name.hasPrefix("Thomas") || voix.name.hasPrefix("Audrey") || voix.name.hasPrefix("Aurélie") { rang += 5 }
        return rang
    }

    static func meilleureVoix() -> AVSpeechSynthesisVoice? { voixFrancaises().first }

    func liste() {
        emettre([
            "ev": "voix",
            "choisie": voix?.identifier ?? "",
            "liste": Bouche.voixFrancaises().map {
                ["id": $0.identifier, "nom": $0.name, "langue": $0.language, "qualite": $0.quality.rawValue]
            }
        ])
    }

    func choisir(_ identifiant: String) {
        if let choisie = AVSpeechSynthesisVoice(identifier: identifiant) { voix = choisie }
    }

    func regler(vitesse: Double) { self.vitesse = Float(vitesse) }

    func dire(id: String, texte: String) {
        let phrase = AVSpeechUtterance(string: texte)
        phrase.voice = voix
        phrase.rate = min(AVSpeechUtteranceDefaultSpeechRate * vitesse, AVSpeechUtteranceMaximumSpeechRate)
        identifiants[phrase] = id
        synthese.speak(phrase)
    }

    /**
     * La premiere prise de parole d'une voix coute presque une seconde de
     * chargement ; les suivantes, quelques dizaines de millisecondes. On lui
     * fait dire un mot en silence a l'entree dans le mode, pour que la
     * premiere vraie phrase parte a chaud. Un blanc ne suffit pas a charger
     * la voix — il faut un mot.
     */
    func chauffer() {
        let phrase = AVSpeechUtterance(string: "un")
        phrase.voice = voix
        phrase.volume = 0
        identifiants[phrase] = Bouche.CHAUFFE
        synthese.speak(phrase)
    }

    /**
     * Se taire immediatement : la phrase en cours s'arrete au milieu d'un mot,
     * celles en file sont abandonnees. On rend ou l'on en etait — la phrase et
     * le dernier mot commence — avant que le synthetiseur ne l'oublie.
     */
    func stop() {
        let id = enCours
        let mot = dernierMot
        synthese.stopSpeaking(at: .immediate)
        // Les phrases abandonnees ne meritent ni « fin » ni « debut » : on les
        // oublie avant que leurs rappels n'arrivent.
        identifiants.removeAll()
        enCours = nil
        dernierMot = nil
        var evenement: [String: Any] = ["ev": "arret"]
        if let id { evenement["id"] = id }
        if let mot { evenement["mot"] = mot }
        emettre(evenement)
    }

    // MARK: rappels du synthetiseur

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart phrase: AVSpeechUtterance) {
        guard let id = identifiants[phrase], id != Bouche.CHAUFFE else { return }
        enCours = id
        dernierMot = nil
        emettre(["ev": "debut", "id": id])
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString plage: NSRange, utterance phrase: AVSpeechUtterance) {
        guard let id = identifiants[phrase], id != Bouche.CHAUFFE else { return }
        dernierMot = plage.location
        emettre(["ev": "mot", "id": id, "debut": plage.location, "longueur": plage.length])
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish phrase: AVSpeechUtterance) { terminee(phrase) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel phrase: AVSpeechUtterance) { terminee(phrase) }

    private func terminee(_ phrase: AVSpeechUtterance) {
        // Une phrase stoppee a deja ete oubliee : rien a dire.
        guard let id = identifiants.removeValue(forKey: phrase) else { return }
        if id == Bouche.CHAUFFE {
            emettre(["ev": "chaud"])
            return
        }
        if enCours == id {
            enCours = nil
            dernierMot = nil
        }
        emettre(["ev": "fin", "id": id])
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

    /** Ou en est l'oreille : le moteur tourne-t-il, le micro livre-t-il ? */
    func diagnostic() {
        emettre(["ev": "diagnostic", "moteur": moteur.isRunning, "tampons": tampons, "ouverte": ouverte])
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

            let (flux, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            micro.installTap(onBus: 0, bufferSize: 4096, format: formatMicro) { [weak self] tampon, _ in
                self?.tampons += 1
                if let converti = Oreille.convertir(tampon, avec: convertisseur, vers: formatAnalyse) {
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

let bouche = Bouche()
var oreille: Oreille? = nil
if #available(macOS 26.0, *) { oreille = Oreille() }

func traiter(_ commande: String, _ objet: [String: Any]) {
    switch commande {
    case "dire":
        bouche.dire(id: objet["id"] as? String ?? "", texte: objet["texte"] as? String ?? "")
    case "stop":
        bouche.stop()
    case "voix":
        if let id = objet["id"] as? String { bouche.choisir(id) }
    case "vitesse":
        if let valeur = objet["valeur"] as? Double { bouche.regler(vitesse: valeur) }
    case "chauffer":
        bouche.chauffer()
    case "voix-liste":
        bouche.liste()
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
