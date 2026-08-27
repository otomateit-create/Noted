# Les prompts des agents

**`graines/` n'est pas la source de verite.** C'est la copie d'installation :
ce qui est ecrit dans le vault d'un Mac neuf au tout premier lancement, et
plus rien apres.

Le prompt qui tourne vit dans le vault, en clair :

    ~/Documents/Noted/Prompts/assistant.md
    ~/Documents/Noted/Prompts/tuteur.md
    ~/Documents/Noted/Prompts/generateur.md

C'est ce fichier-la que l'ecran Parametres modifie, c'est celui-la qui part au
modele, et c'est celui-la qu'il faut editer pour changer le comportement d'un
agent — jamais la graine.

`npm run installer` recopie les fichiers du vault dans `graines/` avant de
construire (voir `scripts/synchroniser-prompts.mjs`). Modifier une graine a la
main serait donc doublement inutile : elle ne change rien au comportement, et
la prochaine construction l'ecrase.

## Les reperes

Deux reperes sont remplis a l'envoi, dans n'importe lequel des trois prompts :

- `{{couleurs}}` — la legende des cinq codes couleur de surlignage
- `{{tableaux}}` — les habillages de tableau et leurs accents

Ils sont pris a `shared/types.ts`, la ou l'application valide ce que le modele
propose. Les ecrire en toutes lettres a leur place marcherait, mais le prompt
se perimerait en silence le jour ou un design change : il continuerait
d'annoncer un nom que la validation refuse.
