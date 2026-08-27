/*
 * Fabrique l'icone de l'application.
 *
 *   node build/icone.mjs
 *
 * Le dessin vit ici, en SVG, et non dans un fichier binaire : une couleur des
 * jetons qui change se repercute en une ligne. Deux versions sont produites,
 * parce qu'un dessin qui tient a 512 pixels devient une bouillie a 16 : sous
 * 32 pixels, on ne garde que les deux pages et la marque de surlignage.
 *
 * sharp arrive avec transformers.js ; c'est le seul rasteriseur SVG present
 * dans le projet. Ce script ne tourne pas au moment de la construction, on ne
 * l'appelle qu'a la main quand le dessin change.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ICI = dirname(fileURLToPath(import.meta.url))

/* --- Palette, reprise de src/renderer/src/styles/tokens.css --------------- */
const ENCRE_HAUT = '#4a4034'
const ENCRE_BAS = '#231e19'
const PAGE_COURS = '#ddd4c4' /* --paper-deep, un peu plus sombre : le support */
const PAGE_NOTE = '#fffefa' /* --paper-sheet : la feuille ou l'on ecrit */
const TEXTE = '#6b6153'
const TEXTE_FAIBLE = '#a49a88'
const LAITON = '#dcac2e'

/*
 * Gabarit macOS : toile de 1024, pastille de 824 posee a 100,100, rayon 185,4.
 * Les 100 pixels de marge accueillent l'ombre portee, que le systeme n'ajoute
 * pas lui-meme.
 */
const PASTILLE = `
  <g filter="url(#ombre-pastille)">
    <rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#fond)"/>
  </g>`

const DEFS = `
  <linearGradient id="fond" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${ENCRE_HAUT}"/>
    <stop offset="1" stop-color="${ENCRE_BAS}"/>
  </linearGradient>
  <filter id="ombre-pastille" x="-15%" y="-15%" width="130%" height="130%">
    <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#1a1410" flood-opacity="0.3"/>
  </filter>
  <filter id="feuille" x="-25%" y="-25%" width="150%" height="150%">
    <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000" flood-opacity="0.42"/>
  </filter>`

/* Geometrie des deux pages, partagee par les deux versions du dessin. */
const Y = 300
const H = 404
const LARGEUR = 262
const GAUCHE_X = 228
const DROITE_X = 534 /* gouttiere de 44 : en dessous, les pages se collent en petit */

/** Lignes de texte simulees. `null` laisse un blanc — la ou passe le surlignage. */
function lignes(x, y, largeurs, couleur, pas = 40, epaisseur = 15) {
  return largeurs
    .map((largeur, index) =>
      largeur === null
        ? ''
        : `<rect x="${x}" y="${y + index * pas}" width="${largeur}" height="${epaisseur}" rx="${epaisseur / 2}" fill="${couleur}"/>`
    )
    .join('')
}

/** Le dessin complet : le cours a gauche, la note surlignee a droite. */
const DETAILLE = `
  <rect x="${GAUCHE_X}" y="${Y}" width="${LARGEUR}" height="${H}" rx="16" fill="${PAGE_COURS}"/>
  ${lignes(GAUCHE_X + 34, Y + 52, [188, 164, 188, 138, 188, 164, 100], TEXTE_FAIBLE)}
  <g filter="url(#feuille)">
    <rect x="${DROITE_X}" y="${Y}" width="${LARGEUR}" height="${H}" rx="16" fill="${PAGE_NOTE}"/>
  </g>
  <rect x="${DROITE_X + 26}" y="${Y + 104}" width="210" height="52" rx="11" fill="${LAITON}"/>
  ${lignes(DROITE_X + 34, Y + 52, [172, null, 146], TEXTE)}
  ${lignes(DROITE_X + 34, Y + 232, [188, 156, 114], TEXTE)}`

/*
 * Version pour 16 et 32 pixels : les traits de texte y font moins d'un demi
 * pixel et se transforment en salissure grise. On ne garde que ce qui survit —
 * deux pages de valeurs differentes, et la marque de laiton.
 */
const SIMPLIFIE = `
  <rect x="${GAUCHE_X}" y="${Y}" width="${LARGEUR}" height="${H}" rx="16" fill="${PAGE_COURS}"/>
  <rect x="${DROITE_X}" y="${Y}" width="${LARGEUR}" height="${H}" rx="16" fill="${PAGE_NOTE}"/>
  <rect x="${DROITE_X + 26}" y="${Y + 118}" width="210" height="64" rx="12" fill="${LAITON}"/>`

function dessin(contenu) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${DEFS}</defs>${PASTILLE}${contenu}
</svg>`
}

/* --- Production ---------------------------------------------------------- */

const detaille = dessin(DETAILLE)
const simplifie = dessin(SIMPLIFIE)
writeFileSync(join(ICI, 'icone.svg'), detaille)
writeFileSync(join(ICI, 'icone-petite.svg'), simplifie)

const JEU = join(ICI, 'icone.iconset')
rmSync(JEU, { recursive: true, force: true })
mkdirSync(JEU, { recursive: true })

/* Chaque entree : nom attendu par iconutil, taille en pixels. */
const ENTREES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

for (const [nom, taille] of ENTREES) {
  const source = taille <= 32 ? simplifie : detaille
  await sharp(Buffer.from(source), { density: (taille / 1024) * 72 * 4 })
    .resize(taille, taille)
    .png()
    .toFile(join(JEU, nom))
}

execFileSync('iconutil', ['-c', 'icns', JEU, '-o', join(ICI, 'icon.icns')])
rmSync(JEU, { recursive: true, force: true })

/* electron-builder attend build/icon.icns ; le PNG sert a la fenetre sous les
   systemes qui ne lisent pas l'icns, et a se relire le dessin. */
await sharp(Buffer.from(detaille)).resize(512, 512).png().toFile(join(ICI, 'icon.png'))

console.log('icone ecrite : build/icon.icns et build/icon.png')
