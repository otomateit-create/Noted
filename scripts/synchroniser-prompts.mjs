/**
 * Recopie les prompts du vault dans les graines du depot, avant de construire.
 *
 * Le prompt qui tourne vit dans ~/Documents/Noted/Prompts/. C'est la seule
 * source de verite : l'ecran Parametres l'ecrit, Obsidian l'ouvre, les agents
 * le lisent. Les fichiers de src/main/prompts/graines/ n'en sont que la copie
 * d'installation — ce qu'un Mac neuf ecrira dans son vault au premier
 * lancement.
 *
 * Sans ce script, cette copie se perimerait des la premiere modification faite
 * dans l'application, et le depot cesserait de dire ce que fait Noted.
 *
 * Le sens de la recopie ne s'inverse jamais : le vault ecrase la graine, la
 * graine n'ecrase jamais le vault. Modifier une graine a la main est donc sans
 * effet — la prochaine construction la remplacera.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = ['assistant', 'tuteur', 'generateur', 'memoire', 'descripteur', 'voix']

// Le meme chemin que main/vault.ts. Un script de construction ne peut pas
// importer le code de l'application : il tourne avant qu'elle soit batie.
const VAULT_PROMPTS = path.join(homedir(), 'Documents', 'Noted', 'Prompts')
const GRAINES = path.join(fileURLToPath(new URL('..', import.meta.url)), 'src/main/prompts/graines')

let changes = 0

for (const id of ID) {
  const source = path.join(VAULT_PROMPTS, `${id}.md`)
  const graine = path.join(GRAINES, `${id}.md`)

  if (!existsSync(source)) {
    // Vault absent — une construction sur une machine qui n'a jamais lance
    // Noted. La graine du depot reste la reference, c'est exactement son role.
    console.log(`  · ${id} : pas de fichier dans le vault, graine conservee`)
    continue
  }

  const contenu = readFileSync(source, 'utf8')

  // Un fichier vide n'est pas une modification, c'est un accident : le
  // recopier livrerait une application dont un agent n'a plus de consigne.
  if (!contenu.trim()) {
    console.warn(`  ! ${id} : fichier vide dans le vault, graine conservee`)
    continue
  }

  if (existsSync(graine) && readFileSync(graine, 'utf8') === contenu) {
    console.log(`  · ${id} : inchange`)
    continue
  }

  writeFileSync(graine, contenu, 'utf8')
  console.log(`  ✓ ${id} : graine mise a jour (${contenu.length} caracteres)`)
  changes += 1
}

console.log(
  changes === 0
    ? 'Prompts : le depot etait deja a jour.'
    : `Prompts : ${changes} graine(s) mise(s) a jour depuis le vault.`
)
