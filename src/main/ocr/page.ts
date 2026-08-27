/**
 * Lire une page : reperer, decouper, lire chacun selon sa nature, recoudre.
 *
 * C'est la chaine en deux etages decrite par le rapport technique de GLM-OCR,
 * et la raison d'etre de tout ce dossier. La version precedente envoyait la
 * page entiere avec « Text Recognition: » — la seule tache qui, de l'aveu du
 * rapport, « rend du texte nu ». Un tableau en ressortait aplati en lignes, une
 * formule en charabia, un titre indistinct d'un paragraphe.
 *
 * Ce qui change tient en une phrase : **on sait desormais ce qu'on regarde
 * avant de le lire.** Un tableau part avec la tache tableau, une formule avec
 * la tache formule, un titre est lu a part pour pouvoir s'ecrire « ## », un
 * schema n'est plus lu du tout mais garde comme image. Et les en-tetes, pieds
 * de page et numeros de page ne sont plus lus non plus, ce qui nettoie le cours
 * autant que l'index.
 *
 * **Rien n'est obligatoire.** Sans detecteur — pas encore telecharge, Node
 * absent, image qui ne se laisse pas analyser — on retombe exactement sur le
 * comportement precedent : la page entiere, en une fois. C'est ce qui permet
 * d'ajouter cet etage sans rien casser de ce qui marchait.
 */

import type { OcrRead } from '../../shared/types'
import { fitToOcrBudget } from '../../shared/types'
import { keepImage } from '../media'
import { readImage } from './engine'
import { detectRegions } from './layout'
import { planPage, type Job, type JobKind } from './regions'

/**
 * Options de lecture d'une page.
 */
export interface PageOptions {
  /**
   * Garder les schemas comme images dans le cours.
   *
   * Vrai pour une photo ou une page de PDF, ou l'image du schema n'existe nulle
   * part ailleurs. Faux quand on lit une image deja affichee par ailleurs — le
   * regime des captures inserees dans un document Word : la dupliquer dans le
   * texte ferait apparaitre deux fois la meme chose. Dans les deux cas, ce qui
   * est ecrit sur le schema est lu ; seule l'image est gardee ou non.
   */
  keepFigures?: boolean
}

/**
 * Lit une page et rend son Markdown.
 *
 * Ne leve jamais, et garde exactement les deux formes de reponse negative du
 * moteur : `null` quand rien n'a pu etre lu, et `{ markdown: '' }` quand la
 * page a bien ete regardee et n'avait rien a dire.
 */
export async function readPage(
  png: Buffer,
  options: PageOptions = {}
): Promise<OcrRead | null> {
  const layout = await detectRegions(png)
  const jobs = layout ? planPage(layout) : []

  // Sans detecteur, ou sur une page ou il n'a rien trouve : la page entiere,
  // comme avant. Une page peut n'avoir aucune region — une photo floue, une
  // feuille blanche — et la lire en entier reste la meilleure reponse.
  if (jobs.length === 0) {
    // La page entiere part au modele, et elle doit donc repasser sous le
    // plafond d'une image seule — celui au-dela duquel l'encodeur visuel
    // epuise la memoire graphique.
    const whole = await fitPng(png)
    return whole ? readImage(whole) : null
  }

  const pieces: string[] = []
  let failed = false

  for (const job of jobs) {
    const piece = await readJob(png, job, options)
    if (piece === null) failed = true
    else if (piece) pieces.push(piece)
  }

  // Rien n'en sort, et au moins une region n'a pas pu etre lue : la page n'a
  // pas ete lue, et le dire permet de la reprendre plus tard. Mais une page
  // dont chaque region a ete regardee sans rien donner est un resultat, et il
  // se garde — sans quoi une capture faite d'un seul schema, ou d'un tableau
  // muet, etait reprise a chaque ouverture du cours et ne coutait jamais moins
  // de vingt secondes. C'est exactement ce qui arrivait : aucune lecture de
  // figure n'atteignait plus le cache, et chaque ouverture d'un cours illustre
  // relisait toutes ses images.
  if (pieces.length === 0 && failed) return null

  return { markdown: pieces.join('\n\n').trim() }
}

/**
 * Decoupe une region et la lit selon sa nature.
 *
 * Deux reponses negatives, et elles ne se confondent pas : `null` quand le
 * moteur n'a pas pu travailler — decoupe impossible, serveur tombe, lecture
 * interrompue — et `''` quand la region a bien ete regardee et n'avait rien a
 * dire. La premiere se reprend plus tard ; la seconde est un resultat.
 */
async function readJob(png: Buffer, job: Job, options: PageOptions): Promise<string | null> {
  const crop = await cut(png, job)
  if (!crop) return null

  if (job.kind === 'figure') return options.keepFigures ? figure(crop) : labels(crop)

  const read = await readImage(crop, task(job.kind))
  if (!read) return null

  const text = read.markdown.trim()
  if (!text) return ''

  if (job.kind === 'title') return heading(text)
  if (job.kind === 'formula') return formula(text)
  if (job.kind === 'table') return table(text)
  return text
}

function task(kind: JobKind): 'text' | 'table' | 'formula' {
  if (kind === 'table') return 'table'
  if (kind === 'formula') return 'formula'
  return 'text'
}

/**
 * Decoupe une region et la rend en PNG a la taille prevue par le budget.
 *
 * `sharp` plutot que `sips` : il est deja embarque — le moteur de vecteurs en
 * depend — et il travaille en memoire, sans le detour par un fichier temporaire
 * qu'impose `sips`. Sur une page de dix regions, cela fait dix allers-retours
 * disque en moins.
 */
async function cut(png: Buffer, job: Job): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default

    return await sharp(png, { failOn: 'none' })
      .extract({ left: job.left, top: job.top, width: job.width, height: job.height })
      .resize(job.scaledWidth, job.scaledHeight, { fit: 'fill' })
      .png()
      .toBuffer()
  } catch (cause) {
    // La decoupe ne depend d'aucun modele : si elle echoue, c'est `sharp` qui
    // manque ou l'image qui ne se laisse pas ouvrir, et cela doit se lire
    // quelque part — toutes les regions de la page partagent ce sort.
    console.warn('[ocr] decoupe de region impossible :', cause)
    return null
  }
}

/**
 * Un titre, ecrit comme tel.
 *
 * Deux croisillons et non un : le cours n'a pas de titre de niveau un — c'est
 * son nom de fichier qui le porte — et commencer a deux laisse la hierarchie
 * du document intacte. Les sauts de ligne sont ecrases : un titre qui tenait
 * sur deux lignes dans la page reste un seul titre.
 */
function heading(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line ? `## ${line}` : ''
}

/**
 * Une formule isolee, en bloc.
 *
 * Le modele rend du LaTeX, parfois deja enveloppe. On ne double pas
 * l'enveloppe : `$$x$$` dans un `$$…$$` ne s'affiche plus.
 */
function formula(text: string): string {
  const bare = text
    .replace(/^\$\$?/, '')
    .replace(/\$\$?$/, '')
    .replace(/^\\\[/, '')
    .replace(/\\\]$/, '')
    .trim()

  return bare ? `$$\n${bare}\n$$` : ''
}

/**
 * Un tableau, ramene au Markdown quand le modele a rendu du HTML.
 *
 * La conversion est necessaire parce que la sortie n'est pas garantie : le
 * rapport technique annonce « des tableaux Markdown ou du texte structure »
 * (§5.3.2), la documentation produit de Z.AI annonce du HTML, et le rapport
 * reconnait par ailleurs une « variabilite stochastique des comportements de
 * formatage » (§6.3). On accepte donc les deux et l'on n'en garde qu'un — le
 * Markdown, que le recousage entre pages sait deja suivre d'une page a l'autre
 * (`assemble.ts`) et que l'editeur sait afficher.
 */
function table(text: string): string {
  return /<table[\s>]/i.test(text) ? htmlToMarkdown(text) : text
}

/**
 * Rend leur caractere aux entites HTML.
 *
 * Le modele en produit, et pas seulement les quatre habituelles : verifie sur
 * un vrai tableau de cours, ou « l'information » etait rendu
 * « l&#x27;information ». Sans ce passage, les apostrophes du cours restent
 * des suites de caracteres — visibles a l'ecran, et cherchees pour rien par
 * l'index.
 *
 * `&amp;` est traite en dernier, sans quoi « &amp;lt; » deviendrait « < » au
 * lieu de « &lt; ».
 */
function entities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Traduit un tableau HTML simple en Markdown.
 *
 * Simple au sens strict : les cellules fusionnees ne survivent pas a la
 * traduction, et c'est assume — Markdown ne sait pas les exprimer. Une cellule
 * qui couvrait trois colonnes rend son texte dans la premiere et laisse les
 * autres vides, ce qui reste lisible et reste juste quant au contenu.
 */
function htmlToMarkdown(html: string): string {
  const rows: string[][] = []

  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = []
    for (const cell of row[1].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi)) {
      cells.push(
        entities(cell[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
          // La barre verticale est le separateur de colonnes : laissee telle
          // quelle, une cellule qui en contient casse toute la ligne.
          .replace(/\|/g, '\\|')
          // Une cellule ne peut pas contenir de saut de ligne en Markdown, et
          // le modele en met : le tableau serait coupe en deux a cet endroit.
          .replace(/\s+/g, ' ')
          .trim()
      )
    }
    if (cells.length > 0) rows.push(cells)
  }

  if (rows.length === 0) return entities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

  const columns = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]): string =>
    `| ${Array.from({ length: columns }, (_, i) => row[i] ?? '').join(' | ')} |`

  const [header, ...body] = rows
  return [pad(header), `|${' --- |'.repeat(columns)}`, ...body.map(pad)].join('\n')
}

/**
 * Garde un schema comme image, et rend le Markdown qui le montre.
 *
 * Choix arrete avec l'utilisateur : tout en local. GLM-OCR n'a aucune tache
 * pour les schemas — son rapport n'en decrit que quatre, et aucune ne convertit
 * une frise ou une carte mentale en structure. Lui demander de « lire » un
 * schema ne rendrait que ses etiquettes dans le desordre, en perdant ce qui
 * fait un schema : les liens entre elles.
 *
 * On garde donc l'image, qui dit tout, et l'on y ajoute ce que la tache texte
 * tire de ses etiquettes — non pour l'afficher joliment, mais pour que la
 * recherche et l'assistant retrouvent le schema par ce qui y est ecrit. Un
 * schema muet dans un cours est un trou dans l'index.
 */
async function figure(crop: Buffer): Promise<string | null> {
  const name = await keepImage(crop, 'image/png').catch(() => null)
  if (!name) return null

  const read = await readImage(crop)
  const text = read?.markdown.replace(/\s+/g, ' ').trim() ?? ''

  const image = `![Schéma](noted-media://${name})`
  return text ? `${image}\n\n${text}` : image
}

/**
 * Les etiquettes d'un schema, sans l'image.
 *
 * C'est le regime A — les captures d'un document par ailleurs lisible : l'image
 * est deja affichee a sa place dans le cours, la redonner la ferait apparaitre
 * deux fois. Mais ce qui y est ecrit doit entrer dans l'index, comme avant que
 * la page ne soit decoupee en regions : un schema muet dans un cours est un
 * trou dans la recherche. `null` si le moteur n'a pas pu, `''` s'il n'a rien lu.
 */
async function labels(crop: Buffer): Promise<string | null> {
  const read = await readImage(crop)
  if (!read) return null
  return read.markdown.replace(/\s+/g, ' ').trim()
}

/**
 * Reduit une image a ce que le moteur accepte, sans la decouper.
 *
 * C'est le chemin de repli : il sert quand la mise en page n'a pas pu etre
 * etablie, et il reproduit exactement ce que faisait `toPng` — meme budget,
 * meme resultat. Il vit ici parce que `sharp` y est deja, et qu'il evite un
 * aller-retour par le disque.
 */
export async function fitPng(png: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default

    const image = sharp(png, { failOn: 'none' })
    const meta = await image.metadata()
    const size = fitToOcrBudget(meta.width ?? 0, meta.height ?? 0)
    if (size.width <= 0 || size.height <= 0) return null

    return await image.resize(size.width, size.height, { fit: 'fill' }).png().toBuffer()
  } catch (cause) {
    console.warn('[ocr] reduction de page impossible :', cause)
    return null
  }
}
