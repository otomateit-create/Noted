/**
 * Les parties vivantes d'un cours HTML, servies a des cadres isoles.
 *
 * Un artefact interactif — un curseur, un pas-a-pas, des cartes a retourner —
 * ne vit que par son script. Ce script ne peut pas tourner dans la fenetre de
 * l'application : il y trouverait le preload, donc le vault et les agents. Le
 * renderer confie donc chaque partie vivante a un `<iframe sandbox>` dont
 * l'origine est opaque, et c'est ici que ce cadre trouve sa page.
 *
 * Un schema a nous, et non `srcdoc` ou `blob:` : ceux-la heritent de la
 * politique de securite de l'application, qui interdit tout script en ligne.
 * Celui-ci envoie la sienne, faite pour un cours : le script et le style de la
 * page, ses images embarquees, et rien du reseau.
 */

import { randomUUID } from 'node:crypto'
import { protocol } from 'electron'

export const FRAME_SCHEME = 'noted-frame'

/**
 * La page du cours ouvert. Une seule a la fois, comme le panneau : ouvrir un
 * autre cours la remplace, et le jeton change avec elle.
 */
let staged: { token: string; page: string } | null = null

const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: noted-media:',
  'font-src data:'
].join('; ')

/** Garde la page et rend l'adresse sous laquelle les cadres la trouveront. */
export function stageFrame(page: string): string {
  staged = { token: randomUUID(), page }
  return `${FRAME_SCHEME}://${staged.token}/`
}

/** Branche le service des cadres. A appeler une fois l'application prete. */
export function serveFrames(): void {
  protocol.handle(FRAME_SCHEME, (request) => {
    // « noted-frame://<jeton>/?part=3 » — la partie a montrer ne regarde que le cadre.
    const token = new URL(request.url).hostname
    if (!staged || staged.token !== token) return new Response('Page introuvable', { status: 404 })

    return new Response(staged.page, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': POLICY
      }
    })
  })
}
