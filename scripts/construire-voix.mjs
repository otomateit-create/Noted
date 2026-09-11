/**
 * Compile le helper vocal (src/main/voix/helper.swift) en binaire natif, a
 * cote du bundle du processus principal — comme le worker de vecteurs, il
 * doit rester un vrai fichier sur le disque, hors de l'archive asar.
 *
 * Tourne a chaque construction du main (dev comme livraison) ; ne recompile
 * que si la source a change depuis, swiftc prenant trois secondes.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const racine = fileURLToPath(new URL('..', import.meta.url))
const source = path.join(racine, 'src/main/voix/helper.swift')
const sortie = path.join(racine, 'out/main/voix-helper')

export function construireVoix() {
  if (existsSync(sortie) && statSync(sortie).mtimeMs >= statSync(source).mtimeMs) return sortie
  mkdirSync(path.dirname(sortie), { recursive: true })
  execFileSync('swiftc', ['-O', '-o', sortie, source], { stdio: 'inherit' })
  return sortie
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(`Helper vocal : ${construireVoix()}`)
}
