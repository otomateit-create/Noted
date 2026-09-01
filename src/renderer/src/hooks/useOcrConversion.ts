/**
 * La conversion d'un document illisible, pendant qu'on le regarde.
 *
 * **Rien n'attend cette conversion.** Le document s'affiche comme d'habitude,
 * tout de suite, et c'est l'original qu'on lit pendant que les pages sont lues
 * une a une en arriere-plan. Le bandeau montre l'avancement ; quand tout est
 * lu, le cours devient sa version en texte et prend la place de l'original dans
 * la bibliotheque.
 *
 * **Deux sources, un seul mecanisme.** Un PDF scanne fournit ses pages en les
 * dessinant — pdf.js vit ici, dans le renderer, et y a deja le document
 * ouvert. Un document Word ou Markdown fait d'images fournit les images
 * elles-memes, deja posees dans le dossier media a l'ouverture : le processus
 * principal les reduit a la taille que le moteur accepte, et chacune devient
 * une page du cours reconstitue.
 */

import { useCallback, useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OCR_PAGE_DPI, fitToPageBudget, type CourseMove } from '@shared/types'
import { renderPage } from '../lib/pdf'

/** D'ou viennent les pages a lire. */
export type ConversionSource =
  | { kind: 'pdf'; document: PDFDocumentProxy }
  | { kind: 'media'; names: string[] }

export interface ConversionState {
  /** Vrai tant que des pages restent a lire. */
  running: boolean
  /** Pages lues, et pages a lire. */
  done: number
  total: number
  /**
   * Nombre de surlignages faits sur l'original, quand la lecture attend un
   * accord. Zero le reste du temps, c'est-a-dire presque toujours.
   */
  asking: number
}

const IDLE: ConversionState = { running: false, done: 0, total: 0, asking: 0 }

type Answer = 'given' | 'refused'

/** Ce que la conversion attend de l'utilisateur, quand elle attend quelque chose. */
export interface ConversionChoice {
  /** Lance la lecture malgre les surlignages. */
  accept: () => void
  /** Y renonce, pour cette ouverture du cours. */
  decline: () => void
}

/**
 * Dessine une page a la resolution pour laquelle le moteur est calibre.
 *
 * **Deux cents points par pouce, et non soixante-douze.** C'est le correctif le
 * plus important de cette chaine, et il tenait a une ligne : la page partait
 * jusqu'ici a `viewport.width`, c'est-a-dire a sa largeur **en points PostScript**
 * — 595 pour une A4. `fitToPageBudget` ne sachant que reduire, rien ne la
 * relevait, et le canvas tombait exactement sur la taille en points du document.
 * Le modele recevait donc une A4 en 595 × 842, ou un caractere de corps fait une
 * dizaine de pixels de haut et ou les traits fins passent sous le pixel. La
 * chaine officielle dessine la meme page en 1654 × 2339 : sept fois et demie
 * plus de surface.
 *
 * Le budget garde le dernier mot, et il porte sur la **surface** : c'est elle
 * qui decide du travail demande a l'encodeur visuel, et un plafond sur un seul
 * cote laisserait passer des images demesurees des que le format s'ecarte du
 * portrait.
 */
export async function pageToPng(
  document: PDFDocumentProxy,
  pageNumber: number
): Promise<Uint8Array | null> {
  const page = await document.getPage(pageNumber)

  try {
    const viewport = page.getViewport({ scale: 1 })

    // Les dimensions d'un PDF sont en points PostScript, soit soixante-douze au
    // pouce : c'est ce rapport qui convertit une page en pixels a la resolution
    // voulue.
    const dpi = OCR_PAGE_DPI / 72

    // Au budget de **page** et non a celui d'une image : cette page sera
    // decoupee en regions dans le processus principal, et chaque region y
    // gagne la resolution que la page entiere lui aurait prise. La reduire ici
    // au plafond d'une image reviendrait a decouper dans une image deja perdue.
    const fitted = fitToPageBudget(Math.round(viewport.width * dpi), Math.round(viewport.height * dpi))

    // `renderPage` peint a la densite de l'ecran — c'est ce qu'il faut a
    // l'affichage, ou une page rendue a la moitie des pixels serait floue sur
    // Retina. Ici c'est exactement ce qu'il ne faut pas : la largeur demandee
    // serait doublee, donc la surface quadruplee, et l'encodeur visuel
    // reclamerait au processeur graphique quatre fois le budget. Il meurt alors
    // sans rien rendre, et la conversion s'acheve sans une seule page lue. On
    // demande donc la largeur divisee par la densite, pour que le canvas tombe
    // sur le budget.
    const density = window.devicePixelRatio || 1

    const canvas = window.document.createElement('canvas')
    await renderPage(page, canvas, fitted.width / density).done

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    )
    if (!blob) return null

    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    // Une page qui ne se dessine pas est une page qu'on ne lira pas. Les autres
    // continuent : c'est la meme regle que pour l'extraction du texte.
    return null
  } finally {
    page.cleanup()
  }
}

/**
 * La n-ieme page de la source, en PNG.
 *
 * Rend aussi la raison d'un manque : une page qui a **echoue** — rendu
 * impossible, image illisible — n'est pas une page **ecartee** — une vignette
 * decorative, trop petite pour porter du texte. La premiere manquera au cours
 * et doit se compter ; la seconde n'a jamais rien eu a lui donner.
 */
async function sourcePng(
  source: ConversionSource,
  pageNumber: number
): Promise<{ png: Uint8Array | null; skipped: boolean }> {
  if (source.kind === 'pdf') {
    return { png: await pageToPng(source.document, pageNumber), skipped: false }
  }

  const name = source.names[pageNumber - 1]
  if (!name) return { png: null, skipped: true }

  const png = await window.noted.ocr.mediaPng(name)
  // Null ici veut dire « decorative ou introuvable », pas « lecture ratee » :
  // le processus principal ecarte avant toute depense.
  return { png, skipped: png === null }
}

/**
 * Lance la conversion quand le document ouvert en a besoin.
 *
 * `scanned` vient de l'extraction du texte : c'est elle qui a constate qu'il n'y
 * avait presque rien a lire. La conversion ne demarre donc jamais sur une
 * supposition, mais sur une mesure faite sur le document lui-meme.
 *
 * **Un seul cas demande un accord** : celui ou la conversion detruirait du
 * travail. Un cours scanne deja surligne a ete annote sur l'original ; en faire
 * un Markdown remplace le texte sur lequel ces surlignages sont poses, et rien
 * ne saura les y replacer. Partout ailleurs il n'y a rien a perdre, donc rien a
 * demander.
 */
export function useOcrConversion(
  courseId: string | null,
  source: ConversionSource | null,
  scanned: boolean,
  onConverted: (moves: CourseMove[]) => void
): ConversionState & ConversionChoice {
  const [state, setState] = useState<ConversionState>(IDLE)
  /**
   * Ce que l'utilisateur a repondu, et pour quel cours.
   *
   * La reponse porte son cours plutot que d'etre remise a zero par un effet :
   * un effet de remise a zero laisserait passer un rendu ou la reponse du cours
   * precedent vaudrait encore pour le nouveau, et la question ne serait pas
   * posee.
   *
   * Un refus vaut pour la seance : revenir au cours ne repose pas la question,
   * ce qui serait harceler, et redemarrer Noted la repose, ce qui laisse
   * changer d'avis.
   */
  const [decision, setDecision] = useState<{ course: string; answer: Answer } | null>(null)
  const consent = decision && decision.course === courseId ? decision.answer : 'unasked'

  useEffect(() => {
    if (!courseId || !source || !scanned || consent === 'refused') {
      setState(IDLE)
      return
    }

    let cancelled = false

    void (async () => {
      // Sans moteur installe, il ne se passe rien du tout : ni bandeau, ni
      // attente, ni message. Le cours se lit comme avant.
      const model = await window.noted.ocr.modelStatus()
      if (cancelled || model.phase !== 'pret') return

      if (consent === 'unasked') {
        // Lu ici et non recu du panneau : la liste des surlignages y arrive de
        // maniere differee, et la trouver vide le temps d'un souffle suffirait a
        // lancer la conversion avant d'avoir pose la question.
        const annotated = await window.noted.annotations.read(courseId)
        if (cancelled) return

        if (annotated.length > 0) {
          setState({ ...IDLE, asking: annotated.length })
          return
        }
      }

      const total = source.kind === 'pdf' ? source.document.numPages : source.names.length
      setState({ running: true, done: 0, total, asking: 0 })

      const pages: { page: number; markdown: string }[] = []
      /** Les pages qui ont echoue — a distinguer de celles qui furent ecartees. */
      const missing: number[] = []

      for (let number = 1; number <= total; number += 1) {
        if (cancelled) return

        const { png, skipped } = await sourcePng(source, number)
        if (cancelled) return

        if (png) {
          const read = await window.noted.ocr.readImage(png)
          if (cancelled) return
          // Une page dont rien n'est sorti n'entre pas dans le cours.
          if (read?.markdown) pages.push({ page: number, markdown: read.markdown })
          else if (read === null) missing.push(number)
        } else if (!skipped) {
          missing.push(number)
        }

        setState({ running: true, done: number, total, asking: 0 })
      }

      // Aucune page lue : mieux vaut laisser le document tel quel que de le
      // remplacer par un fichier vide.
      if (cancelled || pages.length === 0) {
        setState(IDLE)
        return
      }

      // Une source d'images incomplete ne se convertit pas : les images restent
      // dans le dossier media, les lectures faites sont en cache, et la
      // prochaine ouverture reprendra la ou celle-ci s'est arretee — pour le
      // prix des seules pages manquantes. Un PDF, lui, se convertit avec son
      // manque ecrit dans l'en-tete : son original part aux archives, d'ou un
      // bandeau saura relancer la lecture des pages restantes.
      if (source.kind === 'media' && missing.length > 0) {
        setState(IDLE)
        return
      }

      try {
        const result = await window.noted.ocr.convert(
          courseId,
          pages,
          missing.length > 0 ? { missing, pageCount: total } : undefined
        )
        if (cancelled) return

        setState(IDLE)
        onConverted([{ previousId: courseId, nextId: result.courseId }])
      } catch {
        // L'ecriture a echoue — un cours du meme nom existe deja, le disque est
        // plein. Le document d'origine n'a pas bouge, et les lectures faites
        // sont gardees : une nouvelle tentative ne relira rien.
        setState(IDLE)
      }
    })()

    return () => {
      cancelled = true
    }
    // `onConverted` est volontairement absent : il change a chaque rendu du
    // parent, et l'inclure relancerait la conversion depuis le debut a chaque
    // fois qu'une page finit de se lire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, source, scanned, consent])

  const accept = useCallback(() => {
    if (courseId) setDecision({ course: courseId, answer: 'given' })
  }, [courseId])
  const decline = useCallback(() => {
    if (courseId) setDecision({ course: courseId, answer: 'refused' })
  }, [courseId])

  return { ...state, accept, decline }
}
