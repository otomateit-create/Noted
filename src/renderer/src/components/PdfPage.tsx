import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Annotation } from '@shared/types'
import { locateAnnotation } from '../lib/annotate'
import { contribute, withdraw, type PaintedRange } from '../lib/annotation-paint'
import { pageLinks, renderPage, renderTextLayer, type PdfLink } from '../lib/pdf'

/**
 * Distance au-dela de laquelle une page rend son image.
 *
 * Une page peinte occupe environ cinq megaoctets a la densite d'un ecran
 * Retina. Un support de cinquante pages parcouru en entier en gardait deux
 * cent cinquante, pour toute la duree de la lecture, alors qu'on n'en regarde
 * qu'une. Deux mille pixels laissent trois pages de part et d'autre du cadre —
 * de quoi feuilleter sans jamais attendre — et rendent tout le reste.
 */
const KEEP_MARGIN = 2000

/** Rien a peindre : une constante, pour ne pas redessiner sur un tableau neuf. */
const NONE: Annotation[] = []

interface PdfPageProps {
  document: PDFDocumentProxy
  pageNumber: number
  width: number
  /** Ratio hauteur / largeur, pour reserver la place avant le rendu. */
  aspectRatio: number
  /** Les surlignages de cette page, et d'elle seule. */
  annotations?: Annotation[]
  /**
   * Signale l'entree et la sortie du cadre visible, pour savoir quelles pages
   * l'utilisateur avait sous les yeux a un instant donne. Facultatif : le
   * panneau ne le fournit que s'il a quelque chose a en faire.
   */
  onVisible?: (page: number, visible: boolean) => void
  /**
   * Suivre un renvoi interne : la page visee, et ou y tomber — une fraction de
   * sa hauteur depuis le haut. Facultatif : sans lui les renvois restent
   * inertes, les liens externes s'ouvrent quand meme.
   */
  onFollowLink?: (page: number, offset: number) => void
}

/**
 * Une page du document.
 *
 * La page ne se peint que lorsqu'elle approche de l'ecran. Peindre les
 * quarante-cinq pages d'un support de cours au chargement bloquerait
 * l'interface plusieurs secondes pour un resultat que personne ne regarde.
 */
function PdfPage({
  document,
  pageNumber,
  width,
  aspectRatio,
  annotations = NONE,
  onVisible,
  onFollowLink
}: PdfPageProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [painted, setPainted] = useState(false)
  const [links, setLinks] = useState<PdfLink[]>([])
  /**
   * Remonte a chaque fois que la couche de texte est reconstruite. Les
   * surlignages visent des noeuds de cette couche : quand elle est refaite —
   * changement de largeur, retour dans le cadre — les anciennes etendues
   * designent des noeuds qui ne sont plus dans la page.
   */
  const [textGeneration, setTextGeneration] = useState(0)

  // On declenche le rendu bien avant que la page entre dans le cadre, pour
  // qu'elle soit prete quand l'utilisateur y arrive.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setVisible(true)
        }
      },
      { rootMargin: '800px 0px' }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Le pendant du precedent : une page qu'on a laissee loin derriere rend son
  // image. Elle se repeindra en revenant, comme la premiere fois.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue

          setVisible(false)
          setPainted(false)

          const canvas = canvasRef.current
          if (!canvas) continue
          // Remettre les dimensions a zero est ce qui libere vraiment le
          // bitmap ; effacer les tailles CSS rend la main au gabarit qui
          // reserve deja la hauteur, si bien que le defilement ne saute pas.
          canvas.width = 0
          canvas.height = 0
          canvas.style.width = ''
          canvas.style.height = ''
        }
      },
      { rootMargin: `${KEEP_MARGIN}px 0px` }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /**
   * Le troisieme observateur n'a rien a voir avec les deux precedents : eux
   * preparent l'affichage bien avant et bien apres le cadre, celui-ci dit ce
   * que l'utilisateur a reellement sous les yeux. D'ou la marge nulle — une
   * page peinte huit cents pixels plus bas n'est pas une page qu'on lit.
   *
   * On signale l'entree comme la sortie, sans quoi l'appelant ne peut pas
   * tenir sa liste a jour : une page qui s'en va sans le dire y resterait pour
   * toujours. Le demontage compte comme une sortie, pour la meme raison — une
   * page qui n'existe plus n'est plus sous les yeux de personne.
   *
   * L'appelant doit passer une reference stable. Sans cela le memo() du bas de
   * fichier ne retient plus rien, et l'observateur se refait a chaque rendu du
   * panneau en repassant chaque fois par une sortie suivie d'une entree.
   *
   * Limite assumee : a fort zoom, une page plus haute que le cadre le traverse
   * sans jamais y tenir, et elle est signalee visible en entier alors qu'on
   * n'en voit qu'une bande. C'est accepte parce que la recherche qui s'appuiera
   * sur cette liste redecoupe ensuite le texte a l'interieur de chaque page :
   * l'ensemble des candidats est plus large, leur precision reste la meme.
   * Affiner demanderait de regarder les lignes reellement affichees dans la
   * .textLayer — celle dont annotate.ts se sert deja — ce qui reste possible
   * le jour ou la largeur devient genante.
   */
  useEffect(() => {
    const element = containerRef.current
    if (!element || !onVisible) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) onVisible(pageNumber, entry.isIntersecting)
      },
      { rootMargin: '0px' }
    )

    observer.observe(element)
    return () => {
      observer.disconnect()
      onVisible(pageNumber, false)
    }
  }, [onVisible, pageNumber])

  /**
   * La nouvelle largeur prise sur-le-champ, en etirant l'image deja peinte.
   *
   * Le rendu qui suit est asynchrone : sans cet etirement, une page peinte
   * garde sa hauteur d'avant pendant que les pages encore en attente prennent
   * la nouvelle des la trame suivante. Le document a alors deux geometries a
   * la fois, et le panneau ne peut plus retrouver l'endroit ou l'on lisait —
   * un pincement de trackpad faisait sauter vingt pages. L'image etiree est
   * floue le temps d'une trame ou deux, puis le rendu net la remplace.
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    // Largeur nulle : rien n'est peint, et c'est le gabarit qui reserve la
    // hauteur — il l'a deja mise a jour tout seul.
    if (!canvas || canvas.width === 0) return
    canvas.style.width = `${width}px`
    canvas.style.height = `${Math.round((width * canvas.height) / canvas.width)}px`
  }, [width])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    let text: { cancel: () => void } | null = null

    void (async () => {
      const page = await document.getPage(pageNumber)
      if (cancelled || !canvasRef.current) return

      const render = renderPage(page, canvasRef.current, width)
      task = render
      try {
        await render.done
        if (!cancelled) setPainted(true)
      } catch {
        // Un rendu annule n'est pas une panne : c'est le cas normal quand on
        // fait glisser le separateur ou qu'on quitte le document.
      }

      // La couche de texte vient apres l'image : elle ne sert qu'a selectionner,
      // et rien ne presse tant qu'il n'y a rien a voir.
      if (!cancelled && textLayerRef.current) {
        const layer = renderTextLayer(page, textLayerRef.current, width)
        text = layer
        try {
          await layer.done
          if (!cancelled) setTextGeneration((count) => count + 1)
        } catch {
          // Meme raison : la couche est annulee des qu'on change de largeur.
        }
      }

      page.cleanup()
    })()

    return () => {
      cancelled = true
      task?.cancel()
      text?.cancel()
    }
  }, [visible, document, pageNumber, width])

  /**
   * Les liens de la page. A part du rendu, et pour deux raisons : ils ne
   * dependent pas de la largeur d'affichage — leurs boites sont en pourcentage
   * — et ils n'ont pas a etre relus a chaque coup de separateur, la ou
   * l'image, elle, doit etre repeinte.
   */
  useEffect(() => {
    if (!visible) return
    let cancelled = false

    void pageLinks(document, pageNumber).then((found) => {
      if (!cancelled) setLinks(found)
    })

    return () => {
      cancelled = true
    }
  }, [visible, document, pageNumber])

  // Les surlignages de la page, poses sur la couche de texte qui vient d'etre
  // construite. Une page qui sort du cadre retire les siens : ses noeuds
  // disparaissent, et une etendue orpheline ne peint plus rien.
  useEffect(() => {
    const source = `page-${pageNumber}`
    const root = textLayerRef.current
    if (!root || textGeneration === 0 || annotations.length === 0) {
      withdraw(source)
      return
    }

    const painted: PaintedRange[] = []
    for (const annotation of annotations) {
      const ranges = locateAnnotation(root, annotation)
      if (ranges.length > 0) painted.push({ id: annotation.id, colour: annotation.colour, ranges })
    }
    contribute(source, painted)

    return () => withdraw(source)
  }, [pageNumber, annotations, textGeneration])

  return (
    <div
      className="pdf-page"
      ref={containerRef}
      data-painted={painted}
      style={{ width, height: painted ? undefined : width * aspectRatio }}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      {/* Glyphes transparents poses au pixel pres sur ceux de l'image : c'est
          eux que la souris attrape quand on selectionne une phrase. */}
      <div ref={textLayerRef} className="textLayer" />
      {/* Les renvois du document, poses par-dessus la couche de texte. La
          couche ne prend pas les clics, seules ses boites le font : partout
          ailleurs la selection continue de commencer sous le curseur. */}
      {links.length > 0 && (
        <div className="pdf-link-layer">
          {links.map((link, index) => {
            const box = {
              left: `${link.left}%`,
              top: `${link.top}%`,
              width: `${link.width}%`,
              height: `${link.height}%`
            }

            // Un lien externe part au navigateur : `target` fait passer
            // l'ouverture par le gardien de la fenetre, qui la renvoie au
            // systeme plutot que de laisser l'application quitter sa page.
            return link.url ? (
              <a
                key={index}
                className="pdf-link"
                style={box}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Ouvrir ${link.url}`}
                title={link.url}
              />
            ) : (
              <button
                key={index}
                type="button"
                className="pdf-link"
                style={box}
                aria-label={`Aller a la page ${link.page}`}
                title={`Page ${link.page}`}
                onClick={() => link.page && onFollowLink?.(link.page, link.offset)}
              />
            )
          })}
        </div>
      )}
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  )
}

/**
 * Memoise : l'extraction du texte remonte sa progression page par page, et
 * chaque pas redessinait sans cela les cinquante pages du document.
 */
export default memo(PdfPage)
