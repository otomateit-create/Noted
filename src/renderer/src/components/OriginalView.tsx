/**
 * L'original archive d'un cours reconstitue, en consultation seule.
 *
 * Deliberement a l'ecart du chemin habituel du document. Le panneau de cours
 * porte tout un appareil — surlignages peints, ligne de lecture, ancres,
 * synchronisation avec les notes — qui suppose partout que ce qui est affiche
 * est le cours. Faire passer l'original par la, ce serait ouvrir la possibilite
 * de surligner une image qui n'est pas le document de travail, et se retrouver
 * avec deux jeux d'ancres qui ne se correspondent pas.
 *
 * Ici, il n'y a qu'a regarder : des pages dessinees, rien d'accrochable.
 */

import { useEffect, useRef, useState } from 'react'
import { prepareDocumentHtml } from '../lib/document'
import { loadDocument, renderPage } from '../lib/pdf'
import { convertPptx } from '../lib/pptx'

interface OriginalViewProps {
  /** Chemin de l'original, relatif a `Originaux/`. */
  original: string
  /** Largeur utile pour dessiner les pages. */
  width: number
}

export default function OriginalView({ original, width }: OriginalViewProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  /** Le texte d'un original Markdown, montre tel quel. */
  const [text, setText] = useState<string | null>(null)
  /** Un original Word, converti en HTML comme au panneau de cours. */
  const [html, setHtml] = useState<string | null>(null)
  /** Les photos d'un cours qui en est fait, dans l'ordre de lecture. */
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [pageCount, setPageCount] = useState(0)
  const container = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let revoke: string | null = null
    let revokeAll: string[] = []

    setError(null)
    setImageUrl(null)
    setText(null)
    setHtml(null)
    setPhotoUrls([])
    setPageCount(0)

    void (async () => {
      try {
        // Un cours fait de photos a pour original un dossier, pas un fichier :
        // on l'affiche alors comme une suite d'images, dans l'ordre ou elles
        // ont ete lues — le prefixe numerique pose a l'import garantit cet
        // ordre sans qu'il faille le retenir ailleurs.
        const entries = await window.noted.ocr.listOriginal(original)
        if (cancelled) return

        if (entries.length > 0) {
          const urls: string[] = []
          for (const entry of entries) {
            const photo = await window.noted.ocr.readOriginal(`${original}/${entry}`)
            if (cancelled) break
            urls.push(URL.createObjectURL(new Blob([new Uint8Array(photo)])))
          }
          revokeAll = urls
          if (!cancelled) setPhotoUrls(urls)
          return
        }

        // Un original Word se convertit comme au panneau de cours — memes
        // styles, memes images servies depuis le dossier media — et se montre
        // en consultation seule : c'est le document, pas une excuse.
        const extension = original.toLowerCase().split('.').pop() ?? ''
        if (extension === 'docx') {
          const converted = await window.noted.ocr.readOriginalDocx(original)
          if (!cancelled) setHtml(prepareDocumentHtml(converted.html))
          return
        }

        // Un original PowerPoint se reconstruit ici meme, avec la fonction du
        // panneau de cours : la conversion vit deja dans le renderer, il n'y a
        // pas de second chemin a ouvrir dans le processus principal.
        if (extension === 'pptx') {
          const slides = await window.noted.ocr.readOriginal(original)
          if (cancelled) return

          const converted = await convertPptx(slides)
          if (!cancelled) setHtml(prepareDocumentHtml(converted.html))
          return
        }

        const bytes = await window.noted.ocr.readOriginal(original)
        if (cancelled) return

        // Un PDF s'annonce par ses quatre premiers octets. Le reste se
        // reconnait a l'extension : un Markdown se montre en texte, et tout ce
        // qui reste est une image — le cas des photos de cours manuscrits.
        const isPdf =
          bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

        if (!isPdf) {
          if (extension === 'md' || extension === 'markdown') {
            if (!cancelled) setText(new TextDecoder().decode(bytes))
            return
          }

          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
          revoke = url
          if (!cancelled) setImageUrl(url)
          return
        }

        const handle = await loadDocument(bytes)
        if (cancelled) {
          void handle.close()
          return
        }

        setPageCount(handle.document.numPages)

        // Les pages sont dessinees une par une, dans l'ordre. Il n'y a pas de
        // fenetrage ici : on ne consulte un original que ponctuellement, et un
        // rendu paresseux couterait plus de code qu'il n'economise de peine.
        for (let number = 1; number <= handle.document.numPages; number += 1) {
          if (cancelled) break

          const canvas = container.current?.querySelector<HTMLCanvasElement>(
            `canvas[data-page="${number}"]`
          )
          if (!canvas) continue

          const page = await handle.document.getPage(number)
          if (cancelled) {
            page.cleanup()
            break
          }
          await renderPage(page, canvas, width).done
          page.cleanup()
        }

        if (!cancelled) void handle.close()
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()

    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
      for (const url of revokeAll) URL.revokeObjectURL(url)
    }
  }, [original, width])

  if (error) {
    return (
      <div className="course-error" role="alert">
        <strong>Impossible d’ouvrir l’original</strong>
        <span>{error}</span>
      </div>
    )
  }

  return (
    <div className="original-view" ref={container}>
      {imageUrl && <img src={imageUrl} alt={`Original : ${original}`} />}
      {text !== null && <pre className="original-text">{text}</pre>}
      {html !== null && (
        <article className="document-render original-docx">
          {/* Passe par prepareDocumentHtml, comme le panneau de cours : seules
              des balises de document subsistent, sans script ni style. */}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      )}
      {photoUrls.map((url, index) => (
        <img key={url} src={url} alt={`Photo ${index + 1} sur ${photoUrls.length}`} />
      ))}
      {Array.from({ length: pageCount }, (_, index) => (
        <canvas key={index + 1} data-page={index + 1} className="original-page" />
      ))}
    </div>
  )
}
