/**
 * Le brouillon de l'assistant : ce qu'il a ecrit et qui n'est pas encore entre
 * dans la note.
 *
 * Chaque ecriture de l'assistant (`note_brouillon`) est posee aussitot : la
 * note se remplit partie par partie, sous les yeux de l'utilisateur. Le
 * brouillon garde ce qu'une ecriture n'a pas pu poser — le panneau des notes
 * etait ferme, la note changeait sous la frappe —, chaque passage accompagne
 * de la page ou de la section du cours sur laquelle il s'appuie, jusqu'a ce
 * que `note_poser` ou la fin du tour le verse dans la note.
 *
 * Il a longtemps fait plus : tout le tour s'y deposait, puis s'ancrait d'un
 * seul geste, pour que l'ordre des ancres vaille sur l'ensemble. C'etait avant
 * que chaque passage declare sa source ; depuis, c'est elle qui borne l'ancre,
 * et une ecriture n'a plus besoin des autres pour tomber a sa place. Attendre
 * la fin du tour, en revanche, obligeait l'assistant a rediger un resume de
 * cours entier d'une seule traite — plusieurs minutes de silence, et tout
 * perdu a la moindre coupure.
 *
 * Deux raisons restent au detour.
 *
 * La survie. Un refus, une interruption, un plantage : le texte reste sur le
 * disque, dans un fichier que l'on peut lire et recuperer a la main.
 *
 * La tracabilite. Ce fichier garde cote a cote ce que l'assistant a *declare*
 * et ce qu'il a *ecrit*. Une ancre fausse se diagnostique alors : ou la source
 * declaree etait la mauvaise — c'est l'assistant —, ou le passage choisi dans
 * la bonne portee etait le mauvais — c'est le vecteur. Deux fautes distinctes,
 * deux corrections distinctes.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveDraftPath } from './vault'

/**
 * Un passage du brouillon : ce que l'assistant ecrit, et l'endroit du cours
 * dont il parle.
 *
 * `source` est l'ancre lisible telle que `lire` et `rechercher` la rendent —
 * « p. 54 », « p. 60-61 », « 3.4  Les donnees ». C'est volontairement la meme
 * chaine des deux cotes : l'assistant recopie ce qu'il a lu, sans traduction
 * ni vocabulaire a apprendre.
 *
 * `contenu` est un groupe, pas un bloc : tout ce qu'il contient — plusieurs
 * paragraphes, un titre et sa liste, un tableau — partagera une seule ancre.
 * C'est l'assistant qui decide de ce groupement, la ou l'application le
 * devinait autrefois a coups d'heuristiques.
 */
export interface DraftPassage {
  source: string
  contenu: string
}

/** La ligne qui porte la source d'un passage dans le fichier. */
const SOURCE_LINE = /^<!--\s*source:\s*([\s\S]*?)\s*-->$/

/** Toute ligne de source, ou qu'elle se trouve — ce qu'on retire du contenu. */
const ANY_SOURCE_LINE = /^[ \t]*<!--\s*source:[^\n]*?-->[ \t]*$/gm

/**
 * Retire d'un contenu ecrit par le modele les lignes de source.
 *
 * Meme regle que pour les lignes d'ancre : ces lignes appartiennent au
 * dialogue entre l'application et le fichier, jamais au propos. Un modele qui
 * recopierait la structure du brouillon dans son `contenu` — parce qu'il a lu
 * le fichier, parce qu'il imite ce qu'il vient de voir — creerait des passages
 * fantomes a la relecture.
 */
function stripSourceLines(text: string): string {
  return text.replace(ANY_SOURCE_LINE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** L'entete du fichier : de quel cours il s'agit, et depuis quand il attend. */
function header(courseId: string): string {
  return `<!-- brouillon · cours: ${courseId} · ${new Date().toISOString()} -->`
}

/** Le fichier tel qu'il s'ecrit, entete comprise. */
function render(courseId: string, passages: DraftPassage[]): string {
  const body = passages
    .map((passage) => `<!-- source: ${passage.source} -->\n${passage.contenu}`)
    .join('\n\n')
  return `${header(courseId)}\n\n${body}\n`
}

/**
 * Les passages d'un fichier de brouillon.
 *
 * Le decoupage se fait sur les lignes de source et sur rien d'autre : ce qui
 * precede la premiere n'appartient a aucun passage — c'est l'entete — et ce
 * qui suit une source lui revient jusqu'a la suivante. Un fichier edite a la
 * main se relit donc tant qu'il garde ses lignes de source.
 */
function parse(raw: string): DraftPassage[] {
  const passages: DraftPassage[] = []

  for (const line of raw.split('\n')) {
    const match = SOURCE_LINE.exec(line.trim())
    if (match) {
      passages.push({ source: match[1], contenu: '' })
      continue
    }
    const current = passages[passages.length - 1]
    if (current) current.contenu += `${line}\n`
  }

  return passages
    .map((passage) => ({ source: passage.source.trim(), contenu: passage.contenu.trim() }))
    .filter((passage) => passage.source !== '' && passage.contenu !== '')
}

/**
 * Des passages tels qu'ils s'ecrivent : source et texte nettoyes, les vides
 * retires. Le meme nettoyage, qu'ils partent aussitot dans la note ou qu'ils
 * attendent ici.
 */
export function cleanPassages(passages: DraftPassage[]): DraftPassage[] {
  return passages
    .map((passage) => ({
      source: passage.source.trim(),
      contenu: stripSourceLines(passage.contenu)
    }))
    .filter((passage) => passage.contenu !== '')
}

/** Ce qui attend dans le brouillon d'un cours. Vide quand il n'y a rien. */
export async function readDraft(courseId: string): Promise<DraftPassage[]> {
  try {
    return parse(await fs.readFile(resolveDraftPath(courseId), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Ajoute des passages au brouillon et rend son contenu complet.
 *
 * L'ecriture relit le fichier plutot que de tenir un etat en memoire. C'est
 * plus lent d'un aller-retour disque, et c'est ce qu'il faut : le brouillon
 * doit survivre a un rechargement de l'application au milieu d'un tour, et un
 * etat en memoire qui divergerait du fichier ferait perdre des passages sans
 * que rien ne le signale.
 */
export async function appendDraft(
  courseId: string,
  passages: DraftPassage[]
): Promise<DraftPassage[]> {
  const all = [...(await readDraft(courseId)), ...cleanPassages(passages)]
  const target = resolveDraftPath(courseId)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, render(courseId, all), 'utf8')
  return all
}

/**
 * Vide le brouillon d'un cours. Sans effet s'il n'y en a pas — c'est le cas
 * normal a la fin de la plupart des tours.
 */
export async function clearDraft(courseId: string): Promise<void> {
  try {
    await fs.unlink(resolveDraftPath(courseId))
  } catch {
    // Rien a effacer : l'assistant n'a rien ecrit dans ce tour.
  }
}

/** Le brouillon suit un cours renomme ou deplace, comme sa note. */
export async function moveDraft(previousId: string, nextId: string): Promise<void> {
  if (previousId === nextId) return

  const from = resolveDraftPath(previousId)
  const to = resolveDraftPath(nextId)
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
  } catch {
    // Pas de brouillon en attente : le cas ordinaire.
  }
}
