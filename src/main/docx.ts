/**
 * Conversion des cours au format Word.
 *
 * Un .docx est une archive de XML : le lire demande de dezipper puis
 * d'interpreter la mise en forme de Word. Ce travail se fait ici, dans le main
 * process, plutot que cote renderer — la bibliotheque est ecrite pour Node, et
 * l'y laisser evite d'avoir a lui substituer des equivalents navigateur.
 *
 * La sortie est du HTML structure, pas du texte brut : les titres restent des
 * titres et les tableaux des tableaux. C'est ce qui permet a l'IA de citer
 * « la section Structure de la dette » au lieu d'un numero de page qui
 * n'existe pas dans un document Word.
 */

import mammoth from 'mammoth'
import type { DocxDocument } from '../shared/types'
import { MEDIA_SCHEME, keepImage } from './media'
import { resolveCoursePath } from './vault'

/**
 * Ce que mammoth sait faire mais ne declare pas.
 *
 * Ses declarations de types livrees ignorent `transforms` et le texte de
 * remplacement d'une image, tous deux bien presents a l'execution. Plutot que
 * de renoncer aux deux, on decrit ici le strict necessaire.
 */
interface DocxRun {
  type: string
  font?: string
}

interface DocxParagraph {
  type: string
  children?: DocxRun[]
}

const transforms = (
  mammoth as unknown as {
    transforms: {
      paragraph: (
        transform: (paragraph: DocxParagraph) => DocxParagraph
      ) => (document: unknown) => unknown
    }
  }
).transforms

/**
 * Le code d'un cours n'arrive jamais avec un style nomme.
 *
 * Word n'a pas de style « Code » par defaut : celui qui colle un extrait Python
 * dans son support obtient des paragraphes ordinaires, en Consolas. Mammoth ne
 * sait mapper que des styles nommes, et il oublie les polices : les lignes
 * ressortent alors en paragraphes serif, une par ligne, avec l'interligne du
 * corps de texte et l'indentation ecrasee — un extrait de code y devient
 * illisible, et le modele le lit desindente, donc faux.
 *
 * D'ou ce passage prealable : un paragraphe dont tous les fragments sont en
 * police a chasse fixe recoit un style de notre invention, que la table
 * ci-dessous transforme ensuite en <pre><code>. Les paragraphes consecutifs se
 * recollent d'eux-memes ; une ligne vide separe deux blocs.
 *
 * La police, et pas le fond gris : dans ces documents, l'ombrage sert aussi aux
 * encarts, qui ne sont pas du code.
 */
const CODE_STYLE = 'Noted Code'

const MONOSPACE = /consolas|courier|menlo|monaco|lucida console|source code|mono/i

const markCodeParagraphs = transforms.paragraph((paragraph) => {
  const runs = (paragraph.children ?? []).filter((child) => child.type === 'run')
  if (runs.length === 0 || !runs.every((run) => MONOSPACE.test(run.font ?? ''))) {
    return paragraph
  }
  return { ...paragraph, styleId: 'NotedCode', styleName: CODE_STYLE }
})

/**
 * Word applique parfois une mise en forme directe la ou l'on attendrait un
 * style nomme : un titre saisi en gras plutot qu'en « Titre 2 ». Sans ces
 * regles, ces passages arrivent en simples paragraphes et la structure du
 * document se perd.
 */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Titre'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Sous-titre'] => h2:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Citation'] => blockquote:fresh",
  // Le separateur porte sur `code`, pas sur `pre` : sur `pre` on obtiendrait un
  // <code> par ligne au lieu d'un bloc unique.
  `p[style-name='${CODE_STYLE}'] => pre > code:separator('\n')`
]

/**
 * Les images sortent du document et vont sur le disque, au lieu d'etre encodees
 * dans le HTML.
 *
 * Sans cela, un cours de dix-neuf megaoctets dont vingt d'images produisait
 * vingt-sept megaoctets de base64 : a serialiser, a faire passer d'un processus
 * a l'autre, a analyser puis a nettoyer, le tout avant le premier pixel a
 * l'ecran. C'etait la cause des quelques secondes d'attente a l'ouverture.
 * Desormais le HTML ne porte qu'une adresse par image, et le navigateur va
 * chercher chacune quand il en a besoin.
 */
const storeImages = mammoth.images.imgElement(async (image) => {
  const buffer = await image.read()
  const name = await keepImage(buffer, image.contentType)

  return {
    src: `${MEDIA_SCHEME}://${name}`,
    // Le texte de remplacement est conserve : c'est parfois la seule
    // description d'un schema, et il part avec le document vers l'assistant.
    alt: (image as { altText?: string }).altText ?? ''
  }
})

export function readDocx(courseId: string): Promise<DocxDocument> {
  return convertDocxFile(resolveCoursePath(courseId))
}

/**
 * Convertit un fichier Word en HTML, ou qu'il vive. Le chemin doit avoir ete
 * verifie par l'appelant : ici pour un cours, `originalPath` pour un original
 * archive que l'onglet « Original » veut montrer.
 */
export async function convertDocxFile(filePath: string): Promise<DocxDocument> {
  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      styleMap: STYLE_MAP,
      transformDocument: markCodeParagraphs,
      convertImage: storeImages
    }
  )

  return {
    html: result.value,
    // Les messages de mammoth sont techniques ; on ne garde que les avertissements
    // et on les deduplique, sinon un style non reconnu utilise trente fois
    // produit trente lignes identiques.
    warnings: [
      ...new Set(
        result.messages
          .filter((message) => message.type === 'warning')
          .map((message) => message.message)
      )
    ]
  }
}
