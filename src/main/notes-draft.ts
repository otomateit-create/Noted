/**
 * Le brouillon de l'assistant : ce qu'il ecrit avant que cela n'entre dans la
 * note.
 *
 * L'assistant n'ecrit plus directement dans les notes. Il depose ses passages
 * ici, chacun accompagne de la page ou de la section du cours sur laquelle il
 * s'appuie — puis, quand il a fini, l'application ancre tout le brouillon d'un
 * seul geste et le verse dans la note.
 *
 * Trois raisons a ce detour, et la troisieme est celle qui a motive le
 * chantier.
 *
 * D'abord l'ordre. Un tour d'assistant produit souvent plusieurs ecritures ;
 * ancrees separement, chacune ne connait que ses propres blocs, et la
 * monotonie que `resolveAnchorSequence` sait garantir s'arrete a la frontiere
 * d'un appel. Rassembles ici, tous les passages du tour s'ancrent en une seule
 * suite, et l'ordre vaut sur l'ensemble.
 *
 * Ensuite la survie. Un refus, une interruption, un plantage : le texte reste
 * sur le disque, dans un fichier que l'on peut lire et recuperer a la main.
 *
 * Enfin la tracabilite, qui manquait cruellement. Ce fichier garde cote a cote
 * ce que l'assistant a *declare* et ce qu'il a *ecrit*. Une ancre fausse se
 * diagnostique alors : ou la source declaree etait la mauvaise — c'est
 * l'assistant —, ou le passage choisi dans la bonne portee etait le mauvais —
 * c'est le vecteur. Deux fautes distinctes, deux corrections distinctes.
 * Auparavant les deux se confondaient dans un unique « l'ancre est fausse »,
 * et rien dans l'application ne permettait de trancher.
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
  const clean = passages
    .map((passage) => ({
      source: passage.source.trim(),
      contenu: stripSourceLines(passage.contenu)
    }))
    .filter((passage) => passage.contenu !== '')

  const all = [...(await readDraft(courseId)), ...clean]
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
