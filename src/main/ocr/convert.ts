/**
 * Ce qui se passe sur le disque quand un document illisible devient un cours.
 *
 * Quatre gestes, dans cet ordre, et l'ordre est le sujet :
 *
 *   1. arreter le nom sous lequel l'original sera archive ;
 *   2. ecrire le Markdown propre, qui porte ce nom dans son en-tete ;
 *   3. deplacer l'original vers `Originaux/` ;
 *   4. faire suivre la note, les surlignages et le reste.
 *
 * L'ecriture avant l'archivage. L'inverse se lit mieux — on range, puis on
 * installe — mais il ouvre une fenetre pendant laquelle l'original a quitte
 * `Cours/` et son remplacant n'y est pas encore : une panne a cet instant laisse
 * une matiere avec un cours de moins et rien pour le dire. Dans l'ordre retenu,
 * la meme panne laisse le document d'origine a sa place, a cote d'un Markdown en
 * trop. C'est visible, c'est reparable d'un glissement dans le Finder, et ca ne
 * perd rien. D'ou le premier geste, qui n'existe que pour rendre le second
 * possible : l'en-tete doit connaitre l'archive avant qu'elle n'existe.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  OCR_MARKER,
  PAGE_MARKER,
  ocrMarker,
  pageMarker,
  parseOcrMarker,
  type OcrDocument,
  type OcrRead
} from '../../shared/types'
import { moveCourseAnnexes } from '../courses'
import { exists, resolveCoursePath, vaultPaths } from '../vault'
import { assemblePages } from './assemble'
import { OCR_MODEL } from './model'

/** Une page lue, telle que le renderer la remonte au fil de la conversion. */
export interface ConvertedPage extends OcrRead {
  page: number
}

/**
 * Ou l'original ira se ranger, sans l'y mettre encore.
 *
 * Separer le choix du nom de son deplacement effectif est ce qui permet
 * d'ecrire le Markdown en premier : l'en-tete du cours doit porter le chemin de
 * l'original, et il faut donc le connaitre avant d'ecrire, sans pour autant
 * avoir deja demenage quoi que ce soit.
 *
 * Le dossier n'est cree qu'ici, au premier document archive, et non au
 * demarrage : la plupart des installations n'auront jamais de scan a lire, et un
 * dossier vide dans le vault est une question sans reponse pour qui l'ouvre dans
 * le Finder.
 */
async function archiveTarget(courseId: string): Promise<{ absolute: string; relative: string }> {
  const target = path.join(vaultPaths().originals, courseId)
  await fs.mkdir(path.dirname(target), { recursive: true })

  // Un original deja archive sous ce nom — une conversion refaite apres coup —
  // ne s'ecrase pas : on garde les deux, le plus ancien conservant son nom.
  let absolute = target
  let suffix = 2
  while (await exists(absolute)) {
    const extension = path.extname(target)
    absolute = `${target.slice(0, -extension.length)} (${suffix})${extension}`
    suffix += 1
  }

  return { absolute, relative: path.relative(vaultPaths().originals, absolute) }
}

/**
 * Ecrit le cours reconstitue et archive l'original. Renvoie le nouvel
 * identifiant du cours — l'extension change, donc l'identifiant aussi.
 */
export async function convertCourse(
  courseId: string,
  pages: ConvertedPage[],
  report?: { missing: number[]; pageCount: number }
): Promise<{ courseId: string; document: OcrDocument }> {
  if (pages.length === 0) throw new Error('Aucune page lue : rien à convertir.')

  const ordered = [...pages].sort((a, b) => a.page - b.page)
  const body = assemblePages(ordered)

  const extension = path.extname(courseId)
  // Un identifiant sans extension garde son nom entier : `slice(0, -0)` le
  // viderait, et le cours partirait dans un fichier cache « .md ».
  const nextId = extension ? `${courseId.slice(0, -extension.length)}.md` : `${courseId}.md`

  // Le cours reconstitue ne peut pas prendre la place d'un Markdown existant :
  // celui-la est du travail, et il n'a pas demande a etre remplace.
  if (nextId !== courseId && (await exists(resolveCoursePath(nextId)))) {
    throw new Error(`Un cours porte déjà ce nom : ${path.basename(nextId)}.`)
  }

  // Le chemin d'archive est arrete avant l'ecriture, parce qu'il entre dans
  // l'en-tete du cours : c'est lui qui permettra a l'onglet « Original » de
  // retrouver le document de depart.
  const destination = await archiveTarget(courseId)

  const document: OcrDocument = { model: OCR_MODEL, original: destination.relative }
  // Les pages restees illisibles entrent dans l'en-tete : c'est ce qui permet
  // a l'ecran de dire que le cours est incomplet, et de proposer de poursuivre
  // la lecture depuis l'original archive.
  if (report && report.missing.length > 0) {
    document.missing = [...report.missing].sort((a, b) => a - b)
    document.pageCount = report.pageCount
  }

  const target = resolveCoursePath(nextId)
  await fs.mkdir(path.dirname(target), { recursive: true })

  if (nextId === courseId) {
    // Un cours deja en Markdown se convertit sur place. L'ordre habituel —
    // ecrire puis deplacer — detruirait ici l'original avant de l'avoir
    // archive : on le copie donc d'abord dans `Originaux/`, puis on ecrit
    // par-dessus. Une panne entre les deux laisse l'original a sa place et
    // une copie en trop dans les archives — visible, et sans perte.
    await fs.copyFile(resolveCoursePath(courseId), destination.absolute)
    await fs.writeFile(target, `${ocrMarker(document)}\n\n${body}\n`, 'utf8')
    return { courseId: nextId, document }
  }

  await fs.writeFile(target, `${ocrMarker(document)}\n\n${body}\n`, 'utf8')

  // L'original ne bouge qu'une fois son remplacant ecrit et relisible. Une
  // panne ici laisse les deux fichiers dans `Cours/` — visible, sans perte, et
  // reparable d'un glissement dans le Finder.
  await fs.rename(resolveCoursePath(courseId), destination.absolute)

  await moveCourseAnnexes(courseId, nextId)

  return { courseId: nextId, document }
}

/**
 * Insere dans un cours reconstitue des pages qui manquaient a sa conversion.
 *
 * Chaque page fournie sort de la liste des manquantes — une lecture vide est un
 * resultat, pas un echec — et celles qui portent du texte s'inserent a leur
 * place, reperee par les commentaires de page. Pas de recousage ici : recoudre
 * demanderait les pages voisines dans leur etat d'avant assemblage, qui
 * n'existe plus. Une page inseree apres coup reste donc entiere, ce qui se lit
 * tres bien.
 */
export async function patchCourse(
  courseId: string,
  pages: ConvertedPage[]
): Promise<{ missing: number[] }> {
  const target = resolveCoursePath(courseId)
  const text = await fs.readFile(target, 'utf8')

  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  const match = first === -1 ? null : lines[first].trim().match(OCR_MARKER)
  const document = match ? parseOcrMarker(match[1]) : null
  if (!document) throw new Error('Ce cours n’est pas issu d’une lecture par OCR.')

  const missing = new Set(document.missing ?? [])
  const additions = pages
    .filter((page) => missing.has(page.page) && page.markdown.trim() !== '')
    .sort((a, b) => a.page - b.page)

  const body = lines.slice(first + 1)

  for (const page of additions) {
    // La page s'insere avant le premier repere d'une page plus lointaine, ou a
    // la fin du document quand il n'y en a pas.
    const index = body.findIndex((line) => {
      const marker = line.trim().match(PAGE_MARKER)
      return marker !== null && Number(marker[1]) > page.page
    })

    const block = [pageMarker(page.page), '', page.markdown.trim(), '']
    if (index === -1) body.push('', ...block)
    else body.splice(index, 0, ...block)
  }

  const remaining = [...missing].filter((page) => !pages.some((read) => read.page === page)).sort((a, b) => a - b)

  const updated: OcrDocument = { model: document.model, original: document.original }
  if (remaining.length > 0) {
    updated.missing = remaining
    updated.pageCount = document.pageCount
  }

  const content = `${ocrMarker(updated)}\n\n${body.join('\n')}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  await fs.writeFile(target, `${content}\n`, 'utf8')

  return { missing: remaining }
}

/**
 * Cree un cours a partir de photos deja lues.
 *
 * Il n'y a rien a archiver ici : les photos ont ete deposees dans `Originaux/`
 * des l'import, avant meme d'etre lues, precisement pour n'avoir jamais a
 * exister comme cours. Ce qui distingue ce chemin du precedent tient en une
 * phrase : la ou une conversion remplace un cours, celui-ci en fabrique un.
 */
export async function createCourseFromPhotos(
  subject: string,
  title: string,
  original: string,
  pages: ConvertedPage[]
): Promise<{ courseId: string; document: OcrDocument }> {
  if (pages.length === 0) throw new Error('Aucune page lue : rien à créer.')

  const ordered = [...pages].sort((a, b) => a.page - b.page)
  const document: OcrDocument = { model: OCR_MODEL, original }

  const directory = path.join(vaultPaths().courses, subject)
  await fs.mkdir(directory, { recursive: true })

  let courseId = `${subject}/${title}.md`
  let suffix = 2
  while (await exists(resolveCoursePath(courseId))) {
    courseId = `${subject}/${title} (${suffix}).md`
    suffix += 1
  }

  await fs.writeFile(
    resolveCoursePath(courseId),
    `${ocrMarker(document)}\n\n${assemblePages(ordered)}\n`,
    'utf8'
  )

  return { courseId, document }
}

/** Chemin absolu d'un original archive, pour l'onglet qui le montre. */
export function originalPath(relative: string): string {
  const root = vaultPaths().originals
  const target = path.resolve(root, relative)

  // Le chemin vient d'un en-tete de fichier, donc d'une source que l'utilisateur
  // peut editer : « ../../.ssh/id_rsa » est un contenu parfaitement valide tant
  // qu'on ne le regarde pas.
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Original hors du dossier des archives.')
  }
  return target
}
