# Noted

Ton cours à gauche, tes notes au centre, Claude à droite — qui a lu le document
en entier. Application de bureau macOS, 100 % locale.

---

## Démarrer

Pour travailler tes cours, ouvre simplement **Noted** depuis `/Applications`.
Le serveur de développement n'est pas nécessaire, et il coûte cher : 557 Mo au
repos contre 259 Mo pour l'application installée.

Pour mettre l'application à jour après une modification du code :

```bash
npm install          # si ce n'est pas déjà fait
npm run installer    # reconstruit et remplace /Applications/Noted.app
```

Ferme Noted avant de lancer cette commande. Une application construite
localement n'est pas mise en quarantaine par macOS : elle s'ouvre directement,
sans avertissement Gatekeeper.

```bash
npm run dev          # rechargement à chaud, pour développer
npm run package      # construit sans installer, dans release/mac-arm64/
```

### Signature

**Il n'y a rien à faire : macOS accepte déjà l'application.** Vérifié sur
macOS 26.5 — l'app n'a aucun attribut `com.apple.quarantine`, que seuls les
fichiers *téléchargés* reçoivent, et Gatekeeper ne se prononce donc pas au
lancement. Elle s'ouvre par double-clic, sans avertissement.

La signature ne servirait qu'à donner à l'application une identité stable aux
yeux du système, pour que les autorisations qu'on lui accorde (l'accès au
dossier Documents, par exemple) survivent aux reconstructions. Ce n'est pas
gratuit à obtenir :

- **Trousseau d'accès a été retiré de macOS 26**, et l'`Assistant de
  certification` qui subsiste dans `/System/Library/CoreServices/` ne propose
  plus le type *Code Signing*. La route classique du certificat auto-signé n'est
  plus praticable en quelques clics
- La créer en ligne de commande reste possible, mais approuver un certificat
  racine demande le mot de passe administrateur
- Une identité *Developer ID* Apple (99 $/an) ne sert qu'à distribuer
  l'application à d'autres personnes — hors sujet pour un outil local

`package.json` est déjà câblé : il cherche une identité nommée `Noted Local`.
Le jour où elle existe, la construction signe toute seule ; tant qu'elle
n'existe pas, electron-builder l'annonce et poursuit sans signer.

---

## Où vivent tes fichiers

Tout est dans `~/Documents/Noted/`, en texte brut. Rien n'est enfermé dans un
format propriétaire.

```
~/Documents/Noted/
├── Cours/            documents source (PDF, Word, Markdown), classés par matière
│   ├── Private Equity/
│   ├── Corporate Finance/
│   ├── Investment Banking/
│   └── IA/
├── Notes/            tes notes, un .md par cours, même arborescence
├── Memoire/          ce que l'IA retient de toi et de chaque matière
└── .noted/           cache technique
```

> Le dossier de données est volontairement séparé du dossier de code
> (`~/Noted/`) : tes cours ne se mélangent pas aux sources de l'application.

**Ce dossier s'ouvre tel quel dans Obsidian.** Les notes sont du Markdown avec
frontmatter YAML et liens `[[wikilink]]` ; le lien vers le document source
utilise la syntaxe de lien PDF native d'Obsidian, donc il reste cliquable des
deux côtés. Aucune dépendance : Obsidian est une option, pas un prérequis.

Pour ajouter un cours : dépose le fichier dans `Cours/<Matière>/` depuis le
Finder, ou utilise le bouton d'import dans l'application.

---

## Comment l'IA lit ton cours

Le cours n'est pas versé dans le contexte. À l'ouverture, il est découpé en
passages et indexé ; ensuite, l'assistant va chercher lui-même ce dont il a
besoin, question par question.

Deux outils lui sont donnés :

| Outil | Ce qu'il fait |
| --- | --- |
| `rechercher` | remonte les passages liés à des mots-clés, avec leur référence |
| `lire` | renvoie une page ou une section entière, pour le contexte complet |

La recherche est **hybride**, et c'est ce qui la rend fiable :

- **BM25** retrouve les termes exacts — « IFRS 18 », « match_type », un sigle,
  un numéro de norme. Un mot pèse d'autant plus qu'il est rare dans le cours.
- **EmbeddingGemma 300M**, exécuté en local, retrouve le sens — « pourquoi la
  dette rend l'opération risquée » ramène le bon passage même s'il ne contient
  aucun de ces mots.

Les deux classements sont fusionnés sur les rangs, pas sur les scores : un
score BM25 et un cosinus ne vivent pas sur la même échelle.

Le modèle se télécharge une seule fois (326 Mo, dans `.noted/modeles/`) et
tourne ensuite hors ligne, dans un processus séparé. S'il est absent, la
recherche continue sur les seuls mots-clés.

**Un cours n'est vectorisé qu'une fois.** Ses vecteurs sont écrits dans
`.noted/vecteurs/`, un manifeste JSON lisible à côté d'un fichier binaire — les
ouvertures suivantes les relisent en quelques millisecondes, sans rien calculer.
Ils sont recalculés si le document change, si le découpage change ou si le
modèle change ; les trois sont couverts par une seule empreinte.

Chaque passage porte son ancre : `p. 13` pour un PDF, `1. MATCH › Les 3 modes
de match_type` pour un document structuré. C'est ce que l'assistant cite, et
c'est ce que l'application transforme en lien cliquable.

Une recherche typique renvoie **environ 5 % du cours** au lieu de 100 %. La
première réponse ne coûte donc pas le document entier, et rien ne dépend d'un
cache dont la durée de vie est courte.

Quand le cours ne répond pas, l'assistant le dit, puis va chercher sur le web
avec `WebSearch` et `WebFetch` — en distinguant toujours les deux sources.

---

## Authentification

L'application utilise **ton abonnement Claude**, via le binaire `claude` déjà
installé sur ta machine. Aucune clé API n'est requise, et si la variable
`ANTHROPIC_API_KEY` traîne dans ton environnement, elle est explicitement
retirée avant de lancer le sous-processus — sinon la consommation partirait sur
la facturation à l'usage.

Prérequis : être connecté dans Claude Code. Si l'indicateur en haut à droite est
rouge, ouvre un terminal, tape `claude`, connecte-toi, puis relance Noted.

Toute la logique d'authentification est isolée dans
`src/main/claude/provider.ts`. Pour basculer un jour sur une clé API, c'est le
seul fichier à modifier.

---

## Raccourcis

| Raccourci | Action |
|---|---|
| `⌘K` | Ouvrir la bibliothèque de cours |
| `⌘J` | Afficher / masquer le panneau IA |
| `Entrée` | Envoyer le message |
| `⇧Entrée` | Retour à la ligne dans le message |
| `⌘B` `⌘I` `⌘U` | Gras, italique, souligné |

---

## Codes couleur des surlignages

Cinq couleurs, un sens fixe chacune. La légende reste affichée en bas du
panneau du cours — et Claude connaît ces conventions, ce qui rendra possible
« révise tout ce que j'ai marqué en rouge ».

| Couleur | Sens |
|---|---|
| Jaune | À retenir |
| Rouge | Pas compris — alimentera le mode révision |
| Vert | Définition — alimentera les flashcards |
| Bleu | Formule ou chiffre clé |
| Violet | À relier à un autre cours |

Les mêmes couleurs servent dans l'éditeur de notes : un passage marqué
« pas compris » a le même sens des deux côtés.

---

## Structure du code

```
src/
├── main/              processus Node : disque, Claude, IPC
│   ├── claude/
│   │   ├── provider.ts    résolution du binaire + authentification
│   │   ├── prompt.ts      construction du prompt système
│   │   └── session.ts     une conversation par cours
│   ├── vault.ts       arborescence, découverte des cours
│   ├── notes.ts       lecture / écriture Markdown
│   └── ipc.ts         canaux, avec validation des entrées
├── preload/           pont exposé au renderer (contextIsolation actif)
├── renderer/          interface React
└── shared/            types communs aux deux côtés
```

---

## Vérifier

```bash
npm run typecheck    # main + renderer
npm run build        # compile les trois cibles
```

---

## État

**Étapes 1 à 5 livrées** : lecture des PDF, Word et Markdown, prise de notes,
recherche hybride dans le cours par l'IA avec repli web, citations cliquables,
matières libres, formules composées, interface claire.

L'avancement détaillé, étape par étape, vit dans [docs/progression.md](docs/progression.md).
