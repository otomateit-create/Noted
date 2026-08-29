/**
 * Schemas dans l'editeur de notes : cartes mentales, schemas de flux, frises.
 *
 * Un schema est du texte — de la syntaxe Mermaid dans un bloc ```mermaid — et
 * c'est ce qui compte : la note reste un fichier Markdown ordinaire, lisible
 * dans Obsidian, qui rend ces blocs nativement. L'editeur, lui, en compose
 * l'image.
 *
 * Deux moteurs la composent. Mermaid dessine les schemas de flux et les
 * frises ; markmap dessine les cartes mentales — un arbre qui se lit de gauche
 * a droite, dont on replie les branches et que l'on deplace a la souris. Le
 * format stocke, lui, reste du Mermaid dans les deux cas.
 *
 * Chaque moteur n'est charge qu'a la premiere note qui en a besoin — Mermaid
 * pese deux megaoctets et demi. Une note sans schema ne paie ni l'un ni l'autre.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import type { IMarkmapOptions, Markmap } from 'markmap-view'
import { HIGHLIGHT_COLORS } from '@shared/types'
import {
  addAfter,
  addRoot,
  connect,
  locateParts,
  mindPaths,
  mindTree,
  parseDiagram,
  partLabel,
  removePart,
  renamePart,
  setLink,
  setShape,
  writeDiagram
} from './diagram-model'
import type {
  DiagramHandle,
  DiagramModel,
  FlowShape,
  MindModel,
  MindTree,
  PartKey
} from './diagram-model'

type Mermaid = typeof import('mermaid').default
type MarkmapModule = typeof import('markmap-view')

let engine: Promise<Mermaid> | null = null
let mapEngine: Promise<MarkmapModule> | null = null

/** Lit un jeton de design : le schema doit sortir de la meme palette que le reste. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Melange deux couleurs et rend un hexadecimal opaque.
 *
 * Mermaid analyse lui-meme les couleurs qu'on lui donne et ne connait ni
 * `color-mix` ni les fonctions modernes : il refuse le schema entier plutot
 * que d'ignorer la valeur. On calcule donc le melange ici.
 */
function mix(colour: string, ratio: number, over: string): string {
  const channels = (value: string): number[] => {
    const clean = value.trim().replace('#', '')
    const full =
      clean.length === 3
        ? clean
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : clean
    return [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16) || 0)
  }

  const front = channels(colour)
  const back = channels(over)

  return `#${front
    .map((value, index) =>
      Math.round(value * ratio + back[index] * (1 - ratio))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/**
 * Les couleurs du schema, tirees des jetons de l'application et des cinq
 * couleurs semantiques. Les branches d'une carte mentale reprennent ainsi les
 * teintes deja apprises dans le cours : un voile en fond, la couleur pleine en
 * contour.
 */
function palette(): Record<string, string> {
  const scale: Record<string, string> = {}
  const paper = token('--paper')
  const ink = token('--text')

  // Douze niveaux attendus par Mermaid ; les cinq couleurs tournent.
  for (let index = 0; index < 12; index++) {
    const colour = HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length]

    // Un meme voile pour toutes, plutot que les lavis de la legende : ceux-ci
    // sont regles couleur par couleur pour passer derriere du texte, si bien
    // que le jaune ressortait deux fois plus que le rouge en aplat.
    scale[`cScale${index}`] = mix(colour.hex, 0.21, paper)
    scale[`cScaleBorder${index}`] = colour.hex
    scale[`cScaleLabel${index}`] = ink
  }

  // Le coeur d'une carte mentale ne suit aucune des variables documentees : sa
  // regle « .section-root » est ecrite apres les autres et l'emporte, avec un
  // jaune vif qui n'appartient a aucune palette. Elle lit « git0 ».
  scale.git0 = mix(token('--brass'), 0.2, paper)

  return scale
}

async function loadEngine(): Promise<Mermaid> {
  if (engine) return engine

  engine = import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Le contenu vient du modele ou de l'utilisateur : on garde le
      // nettoyage le plus strict, aucun HTML ne passe dans les etiquettes.
      securityLevel: 'strict',
      // Sans ceci, une syntaxe fautive injecte un bonhomme d'erreur dans la
      // page — on prefere l'attraper nous-memes et l'afficher a notre facon.
      suppressErrorRendering: true,
      // Le sans-serif de l'interface : dans une boite etroite, il se lit mieux
      // que le serif de la feuille.
      fontFamily: token('--font-ui'),
      theme: 'base',
      themeVariables: {
        fontSize: '13px',
        // Les boites sont plus claires que la carte qui les porte : sans cet
        // ecart, un schema de flux n'est plus qu'un jeu de contours flottants.
        primaryColor: token('--paper-sheet'),
        primaryTextColor: token('--text'),
        primaryBorderColor: token('--brass-line'),
        secondaryColor: token('--paper-raised'),
        tertiaryColor: token('--paper-deep'),
        mainBkg: token('--paper-sheet'),
        nodeBorder: token('--brass-line'),
        // Un trait de liaison doit se suivre a l'oeil d'un bout a l'autre.
        lineColor: token('--text-faint'),
        textColor: token('--text'),
        clusterBkg: token('--paper-raised'),
        clusterBorder: token('--rule-strong'),
        titleColor: token('--text-dim'),
        // L'etiquette d'une fleche efface le trait derriere elle, sinon les
        // deux se chevauchent.
        edgeLabelBackground: token('--paper'),
        ...palette()
      },
      // `useMaxWidth` etire le dessin jusqu'aux bords du panneau : un schema de
      // cinq boites y devenait un panneau d'affichage haut de mille pixels. A
      // taille naturelle, il occupe ce qu'il vaut — et le style le retrecit
      // s'il deborde, jamais l'inverse.
      flowchart: {
        // `basis`, le reglage d'origine de Mermaid, lisse les traits par une
        // courbe qui ne passe pas par les points calcules : les fleches se
        // decollaient des boites et se gonflaient en S. `stepAfter` garde la
        // route exacte, a angles droits ; `roundCorners` en adoucit ensuite
        // les angles, et l'on retrouve le trait franc des editeurs de flux.
        curve: 'stepAfter',
        padding: 10,
        // De l'air entre les rangs : c'est la ou passent les traits.
        nodeSpacing: 40,
        rankSpacing: 48,
        diagramPadding: 4,
        useMaxWidth: false
      },
      mindmap: { padding: 10, useMaxWidth: false },
      timeline: { useMaxWidth: false }
    })
    return mermaid
  })

  return engine
}

/** Ce que Mermaid reproche a une syntaxe, en une phrase lisible. */
function describeFailure(cause: unknown): string {
  const raw =
    cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : String(cause)

  return raw.replace(/\s+/g, ' ').trim().slice(0, 400)
}

// ---------------------------------------------------------------------------
// Adoucir les traits
// ---------------------------------------------------------------------------

/** Les sommets d'un chemin fait de deplacements et de segments droits. */
function readCorners(path: string): Array<[number, number]> {
  const corners: Array<[number, number]> = []
  const step = /([ML])\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g
  let found: RegExpExecArray | null

  while ((found = step.exec(path)) !== null) corners.push([Number(found[2]), Number(found[3])])
  return corners
}

/** Trois points alignes ne font qu'un segment : le point du milieu s'efface. */
function straighten(corners: Array<[number, number]>): Array<[number, number]> {
  const kept: Array<[number, number]> = []

  for (const point of corners) {
    const last = kept[kept.length - 1]
    if (last && Math.abs(point[0] - last[0]) < 0.01 && Math.abs(point[1] - last[1]) < 0.01) continue

    const before = kept[kept.length - 2]
    if (before && last) {
      const area =
        (last[0] - before[0]) * (point[1] - before[1]) -
        (last[1] - before[1]) * (point[0] - before[0])
      if (Math.abs(area) < 0.5) kept.pop()
    }
    kept.push(point)
  }

  return kept
}

/** Le point situe a `distance` de `from` en allant vers `to`. */
function towards(
  from: [number, number],
  to: [number, number],
  distance: number
): [number, number] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const ratio = Math.min(distance / (Math.hypot(dx, dy) || 1), 0.5)
  return [from[0] + dx * ratio, from[1] + dy * ratio]
}

/**
 * Arrondit les angles d'un trait.
 *
 * Le principe est celui d'un conge : on s'arrete un peu avant l'angle, on le
 * contourne par une courbe qui l'effleure, on repart un peu apres. Le rayon se
 * borne a la moitie du plus court des deux segments voisins — sans quoi deux
 * angles rapproches se mangeraient l'un l'autre et le trait ferait une boucle.
 *
 * Le dernier segment reste droit : c'est lui qui donne son orientation a la
 * pointe de la fleche.
 */
function roundCorners(path: string, radius: number): string {
  const corners = straighten(readCorners(path))
  if (corners.length < 3) return path

  const parts = [`M${corners[0][0]},${corners[0][1]}`]

  for (let index = 1; index < corners.length - 1; index++) {
    const previous = corners[index - 1]
    const corner = corners[index]
    const next = corners[index + 1]

    const span = Math.min(
      radius,
      Math.hypot(corner[0] - previous[0], corner[1] - previous[1]) / 2,
      Math.hypot(next[0] - corner[0], next[1] - corner[1]) / 2
    )

    const entry = towards(corner, previous, span)
    const exit = towards(corner, next, span)
    parts.push(`L${entry[0]},${entry[1]}`, `Q${corner[0]},${corner[1]} ${exit[0]},${exit[1]}`)
  }

  const last = corners[corners.length - 1]
  parts.push(`L${last[0]},${last[1]}`)
  return parts.join('')
}

/**
 * Reprend les traits d'un schema de flux une fois le dessin compose.
 *
 * On passe par un conteneur detache plutot que par une expression sur le
 * texte : c'est le meme analyseur que celui du navigateur, et poser du HTML
 * hors du document n'execute rien.
 */
function softenLinks(svg: string): string {
  const holder = document.createElement('div')
  holder.innerHTML = svg

  for (const path of Array.from(holder.querySelectorAll('path.flowchart-link'))) {
    const drawn = path.getAttribute('d')
    if (drawn) path.setAttribute('d', roundCorners(drawn, 9))
  }

  return holder.innerHTML
}

let serial = 0

/** Compose le schema. Rejette si la syntaxe est fautive. */
export async function renderDiagram(source: string): Promise<string> {
  const mermaid = await loadEngine()
  serial += 1
  const { svg } = await mermaid.render(`noted-schema-${serial}`, source.trim())
  return softenLinks(svg)
}

/**
 * Verifie une syntaxe sans rien afficher. Rend null si elle tient debout, la
 * raison sinon — c'est ce qui permet de refuser une proposition de l'assistant
 * avant qu'elle n'atteigne l'ecran.
 */
export async function validateDiagram(source: string): Promise<string | null> {
  try {
    const mermaid = await loadEngine()
    await mermaid.parse(source.trim())
    return null
  } catch (cause) {
    return describeFailure(cause)
  }
}

// ---------------------------------------------------------------------------
// Cartes mentales : markmap
// ---------------------------------------------------------------------------

function loadMapEngine(): Promise<MarkmapModule> {
  if (!mapEngine) mapEngine = import('markmap-view')
  return mapEngine
}

/**
 * Au-dela de cette taille, une carte arrive repliee : le coeur et ses
 * branches, le reste au clic. C'est ce qui rend une grande carte lisible —
 * et ce que le dessin fige ne permettait pas.
 */
const FOLD_ABOVE = 18

/**
 * Les reglages de markmap pour une carte donnee.
 *
 * La couleur d'une branche est celle de son ancetre de premier niveau, tiree
 * des cinq couleurs semantiques deja apprises dans le cours ; le coeur est
 * laiton. Le trait s'affine en s'eloignant du coeur : c'est ce qui fait lire
 * un tronc et ses ramifications plutot qu'un buisson de traits egaux. Les
 * jetons sont lus au moment du rendu, comme pour Mermaid.
 *
 * markmap compte la profondeur a partir de 1 pour le coeur, et son chemin
 * « 1.4.9 » commence par le numero du coeur puis celui de la branche.
 */
function mindOptions(model: MindModel): Partial<IMarkmapOptions> {
  const branch = new Map<string, number>()
  for (const path of mindPaths(model)) {
    const ids = path.split('.')
    if (ids.length === 2) branch.set(ids[1], branch.size)
  }
  const brass = token('--brass')

  return {
    // Les plis sont poses par `foldTree`, jamais par markmap : son reglage
    // ecraserait ceux que l'utilisateur a deja faits a chaque mise a jour.
    initialExpandLevel: -1,
    autoFit: false,
    duration: 300,
    paddingX: 10,
    spacingHorizontal: 64,
    spacingVertical: 8,
    maxWidth: 240,
    fitRatio: 0.92,
    // Sur Mac, markmap fait defiler la carte a la molette et zoome au
    // pincement. On prefere la molette pour le zoom — et rien du tout tant
    // que la carte n'est pas selectionnee, sinon la note ne defile plus des
    // que le pointeur la survole. C'est la vue qui active le zoom.
    scrollForPan: false,
    pan: false,
    zoom: false,
    color: (node) => {
      const ids = node.state.path.split('.')
      if (ids.length < 2) return brass
      const rank = branch.get(ids[1]) ?? 0
      return HIGHLIGHT_COLORS[rank % HIGHLIGHT_COLORS.length].hex
    },
    lineWidth: (node) => (node.state.depth <= 2 ? 3.2 : node.state.depth === 3 ? 2.4 : 1.8)
  }
}

/**
 * Ce qu'un noeud replie ou ouvert retient de lui-meme, sous deux cles : la
 * chaine de ses libelles (« LBO/Dette »), qui survit a une insertion plus haut
 * dans la carte — les numeros de markmap, eux, se decalent tous —, et son
 * chemin numerique, qui survit a son propre renommage.
 */
type Folds = Map<string, { fold: number; children: number }>

/** Les plis de la carte affichee, avant qu'une mise a jour ne les efface. */
function rememberFolds(map: Markmap): Folds {
  const folds: Folds = new Map()
  const visit = (node: Markmap['state']['data'], parentTrail: string): void => {
    if (!node) return
    const trail = `${parentTrail}/${node.content}`
    if (node.children.length > 0) {
      const memory = { fold: node.payload?.fold ?? 0, children: node.children.length }
      folds.set(`trail:${trail}`, memory)
      folds.set(`path:${node.state.path}`, memory)
    }
    for (const child of node.children) visit(child, trail)
  }
  visit(map.state.data, '')
  return folds
}

/**
 * Pose les plis sur un arbre neuf.
 *
 * `setData` repart de zero : sans cela, renommer un noeud refermerait toute la
 * carte. Les plis connus sont donc repris — sauf sur un noeud qui vient de
 * gagner un enfant, qu'on ouvre pour le montrer. Un noeud inconnu suit la
 * regle d'arrivee : replie a partir de `foldFrom` (le coeur vaut 0). Une
 * feuille ne se plie jamais : markmap lui peindrait un cercle plein.
 */
function foldTree(tree: MindTree, known: Folds, foldFrom: number): void {
  let id = 0
  const visit = (node: MindTree, parentPath: string, parentTrail: string, depth: number): void => {
    id += 1
    const path = parentPath ? `${parentPath}.${id}` : String(id)
    const trail = `${parentTrail}/${node.content}`

    if (node.children.length > 0) {
      const before = known.get(`trail:${trail}`) ?? known.get(`path:${path}`)
      const fold =
        before === undefined
          ? depth >= foldFrom
            ? 1
            : 0
          : before.children < node.children.length
            ? 0
            : before.fold
      node.payload = { fold }
    }
    for (const child of node.children) visit(child, path, trail, depth + 1)
  }
  visit(tree, '', '', 0)
}

/** Les plis d'arrivee d'une carte : tout ouvert si elle est petite. */
function foldFromFor(model: MindModel): number {
  return model.nodes.length > FOLD_ABOVE ? 1 : Infinity
}

/** Le nombre de lignes que la carte ouvre a l'arrivee : c'est lui qui fait sa hauteur. */
function mindRows(model: MindModel): number {
  if (model.nodes.length <= FOLD_ABOVE) return model.nodes.length
  return 1 + mindPaths(model).filter((path) => path.split('.').length === 2).length
}

/**
 * Dessine une carte mentale dans un conteneur quelconque — l'apercu d'une
 * proposition de l'assistant, qui n'est pas un noeud de l'editeur. Sans zoom
 * ni deplacement : on la regarde avant de l'accepter, on ne s'y promene pas.
 */
export async function mountMindmap(holder: HTMLElement, source: string): Promise<void> {
  const model = parseDiagram(source)
  if (!model || model.kind !== 'mindmap') return
  const tree = mindTree(model)
  if (!tree) return

  const { Markmap } = await loadMapEngine()
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'note-mindmap')
  svg.style.setProperty('--mindmap-rows', String(mindRows(model)))
  holder.replaceChildren(svg)

  foldTree(tree, new Map(), foldFromFor(model))
  const map = Markmap.create(svg, mindOptions(model))
  await map.setData(tree)
  await map.fit()
}

/** Ce que le bloc peut demander a la carte : revenir dans son cadre. */
interface MindmapApi {
  fit: () => void
}

/**
 * La carte mentale, dessinee par markmap dans un SVG monte une seule fois et
 * mis a jour sur place. Le remonter a chaque frappe de l'editeur perdrait les
 * plis et la position — et React 19 reecrit tout innerHTML qu'on lui redonne.
 *
 * Le zoom et le deplacement ne s'activent que sur la carte selectionnee : une
 * carte qui capte la molette au simple survol empeche la note de defiler. Le
 * pli au clic sur un cercle, lui, marche toujours.
 */
function MindmapCanvas({
  model,
  selected,
  api
}: {
  model: MindModel
  selected: boolean
  api: React.RefObject<MindmapApi | null>
}): React.JSX.Element {
  const holder = useRef<SVGSVGElement>(null)
  const map = useRef<Markmap | null>(null)
  const [loaded, setLoaded] = useState<MarkmapModule | null>(null)

  useEffect(() => {
    let live = true
    void loadMapEngine().then((module) => {
      if (live) setLoaded(module)
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const svg = holder.current
    if (!loaded || !svg) return undefined

    const created = loaded.Markmap.create(svg, mindOptions(model))
    map.current = created
    api.current = { fit: () => void created.fit() }

    // La largeur du panneau change : la carte se recadre.
    const observer = new ResizeObserver(() => {
      if (created.state.data) void created.fit()
    })
    observer.observe(svg)

    return () => {
      observer.disconnect()
      created.destroy()
      map.current = null
      api.current = null
    }
    // Le modele ne sert qu'a la creation ; ses mises a jour passent par setData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  useEffect(() => {
    const current = map.current
    if (!current) return
    const tree = mindTree(model)
    if (!tree) return

    // La premiere fois, les plis d'arrivee ; ensuite, ceux qu'on avait.
    const first = !current.state.data
    foldTree(tree, first ? new Map() : rememberFolds(current), first ? foldFromFor(model) : Infinity)
    void current.setData(tree, mindOptions(model)).then(() => current.fit())
  }, [loaded, model])

  useEffect(() => {
    const current = map.current
    const svg = holder.current
    if (!current || !svg) return undefined

    current.setOptions({ zoom: selected })
    svg.toggleAttribute('data-live', selected)
    if (!selected) return undefined

    // Selectionnee, la carte garde la souris pour elle : sans cela, ProseMirror
    // prend le glisser pour un deplacement du bloc entier.
    const keep = (event: Event): void => event.stopPropagation()
    svg.addEventListener('mousedown', keep)

    // En mode edition, les poignees recouvrent les libelles et recoivent la
    // molette a la place du SVG : le zoom dependrait alors du pixel sous le
    // pointeur. On la leur reprend et on la rejoue sur la carte.
    const stage = svg.parentElement
    const forward = (event: WheelEvent): void => {
      if (event.target instanceof Element && svg.contains(event.target)) return
      event.preventDefault()
      svg.dispatchEvent(new WheelEvent('wheel', event))
    }
    stage?.addEventListener('wheel', forward, { passive: false })

    return () => {
      svg.removeEventListener('mousedown', keep)
      stage?.removeEventListener('wheel', forward)
    }
  }, [loaded, selected])

  return (
    <svg
      ref={holder}
      className="note-mindmap"
      style={{ '--mindmap-rows': mindRows(model) } as React.CSSProperties}
    />
  )
}

// ---------------------------------------------------------------------------
// Les vignettes des menus de forme
// ---------------------------------------------------------------------------

/**
 * Chaque forme se choisit sur son dessin, pas sur son nom.
 *
 * Les caracteres unicode qui servaient de vignettes — ▭ ◇ ⬭ — sont tires de
 * polices differentes selon celle qui les porte : ils n'avaient ni la meme
 * taille ni la meme graisse, et l'un d'eux manquait. Un trace, lui, est le
 * meme partout et dit exactement ce que la boite deviendra.
 */
function Glyph({ name }: { name: string }): React.JSX.Element {
  return (
    <svg className="note-diagram-glyph" viewBox="0 0 18 14" aria-hidden="true">
      {glyphShape(name)}
    </svg>
  )
}

function glyphShape(name: string): React.JSX.Element {
  switch (name) {
    // Boites d'un schema de flux
    case 'rect':
      return <rect x="1.5" y="3" width="15" height="8" rx="1" />
    case 'diamond':
      return <path d="M9 2 L16.5 7 L9 12 L1.5 7 Z" />
    case 'stadium':
      return <rect x="1.5" y="3" width="15" height="8" rx="4" />
    case 'hexagon':
      return <path d="M4.5 3 H13.5 L16.5 7 L13.5 11 H4.5 L1.5 7 Z" />
    case 'circle':
      return <circle cx="9" cy="7" r="5" />
    case 'cylinder':
      return (
        <>
          <path d="M3 4.5 V9.5 C3 10.6 5.7 11.5 9 11.5 C12.3 11.5 15 10.6 15 9.5 V4.5" />
          <ellipse cx="9" cy="4.5" rx="6" ry="2" />
        </>
      )

    // Traits d'une fleche
    case '-->':
      return (
        <>
          <path d="M2 7 H12.5" />
          <path className="note-diagram-glyph-head" d="M11.5 4.4 L16 7 L11.5 9.6 Z" />
        </>
      )
    case '-.->':
      return (
        <>
          <path strokeDasharray="2.4 2" d="M2 7 H12.5" />
          <path className="note-diagram-glyph-head" d="M11.5 4.4 L16 7 L11.5 9.6 Z" />
        </>
      )
    case '==>':
      return (
        <>
          <path strokeWidth="2.6" d="M2 7 H12" />
          <path className="note-diagram-glyph-head" d="M11 3.9 L16.4 7 L11 10.1 Z" />
        </>
      )
    case '---':
      return <path d="M2 7 H16" />
    case '<-->':
      return (
        <>
          <path d="M5.5 7 H12.5" />
          <path className="note-diagram-glyph-head" d="M6.5 4.4 L2 7 L6.5 9.6 Z" />
          <path className="note-diagram-glyph-head" d="M11.5 4.4 L16 7 L11.5 9.6 Z" />
        </>
      )
    default:
      return <rect x="1.5" y="3" width="15" height="8" rx="1" />
  }
}

/** Les formes proposees pour une boite de schema de flux. */
const FLOW_SHAPES: Array<{ shape: FlowShape; label: string }> = [
  { shape: 'rect', label: 'Étape' },
  { shape: 'diamond', label: 'Décision' },
  { shape: 'stadium', label: 'Début ou fin' },
  { shape: 'hexagon', label: 'Repère' },
  { shape: 'circle', label: 'Jalon' },
  { shape: 'cylinder', label: 'Donnée' }
]

/** Les traits proposes pour une fleche de schema de flux. */
const LINK_STYLES: Array<{ link: string; label: string }> = [
  { link: '-->', label: 'Flèche' },
  { link: '-.->', label: 'Pointillé' },
  { link: '==>', label: 'Trait épais' },
  { link: '---', label: 'Sans pointe' },
  { link: '<-->', label: 'Double sens' }
]

/**
 * La sorte de schema, lue sur son premier mot.
 *
 * Le modele la donne deja quand la syntaxe se relit au clic ; celle-ci prend
 * le relais sinon, pour qu'une frise dont on ne sait pas relire une ligne
 * garde tout de meme l'allure d'une frise.
 */
function kindOf(source: string): string | undefined {
  const first = source.split('\n').find((line) => line.trim())?.trim() ?? ''

  if (/^mindmap\b/.test(first)) return 'mindmap'
  if (/^timeline\b/.test(first)) return 'timeline'
  if (/^(?:flowchart|graph)\b/.test(first)) return 'flowchart'
  return undefined
}

/** Ce que le bouton d'ajout general propose, selon le type de schema. */
function addRootLabel(model: DiagramModel): string {
  switch (model.kind) {
    case 'mindmap':
      return '+ branche'
    case 'flowchart':
      return '+ boîte'
    case 'timeline':
      return '+ étape'
  }
}

/**
 * Le schema affiche, et modifiable a la souris.
 *
 * Trois etats : on le regarde, on le modifie au clic sur ses formes, ou — quand
 * sa syntaxe n'est d'aucun des trois types connus, ou qu'elle ne compile pas —
 * on ouvre le texte. Ce dernier recours n'est pas une commodite : sans lui, un
 * schema casse serait impossible a reparer autrement qu'en le supprimant.
 */
function DiagramView({
  node,
  updateAttributes,
  deleteNode,
  selected
}: NodeViewProps): React.JSX.Element {
  const source = String(node.attrs.source ?? '')
  const [svg, setSvg] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'edit' | 'source'>('view')

  /** L'element en cours de renommage, et celui d'ou part une nouvelle fleche. */
  const [editing, setEditing] = useState<PartKey | null>(null)
  const [linkFrom, setLinkFrom] = useState<PartKey | null>(null)
  const [handles, setHandles] = useState<DiagramHandle[]>([])

  const stage = useRef<HTMLDivElement>(null)
  const mapApi = useRef<MindmapApi | null>(null)
  const model = useMemo(() => parseDiagram(source), [source])
  const isMind = model?.kind === 'mindmap'

  useEffect(() => {
    let cancelled = false

    // Une carte mentale se dessine par markmap : Mermaid n'a rien a y faire.
    if (isMind) {
      setSvg('')
      setFailure(null)
      return undefined
    }

    void renderDiagram(source).then(
      (rendered) => {
        if (cancelled) return
        setSvg(rendered)
        setFailure(null)
      },
      (cause) => {
        if (cancelled) return
        setSvg('')
        setFailure(describeFailure(cause))
      }
    )

    return () => {
      cancelled = true
    }
  }, [source, isMind])

  /**
   * Ou se trouve chaque element du dessin. Mesure apres coup sur le SVG reel
   * plutot que calculee : c'est Mermaid qui decide de la mise en page, et lui
   * seul sait ou il a pose ses boites.
   */
  const locate = useCallback(() => {
    const frame = stage.current
    const drawing = frame?.querySelector('svg')

    if (!frame || !drawing || !model) {
      setHandles([])
      return
    }
    setHandles(locateParts(model, drawing, frame.getBoundingClientRect()))
  }, [model])

  useLayoutEffect(() => {
    if (mode !== 'edit') {
      setHandles([])
      return undefined
    }

    locate()

    // La largeur du panneau change, le schema se remet a l'echelle et toutes
    // les zones bougent avec lui.
    const observer = new ResizeObserver(() => locate())
    if (stage.current) observer.observe(stage.current)

    // Une carte mentale bouge aussi toute seule : un pli retire des noeuds,
    // un zoom ou un deplacement transforme le groupe racine, et markmap
    // anime tout cela image par image. On re-mesure au rythme de l'ecran,
    // pas a chaque mutation.
    let frame = 0
    const watcher = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(locate)
    })
    const drawing = stage.current?.querySelector('svg.note-mindmap')
    if (drawing) {
      watcher.observe(drawing, {
        attributes: true,
        attributeFilter: ['transform'],
        childList: true,
        subtree: true
      })
    }

    return () => {
      observer.disconnect()
      watcher.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [mode, svg, locate])

  /** Applique un geste : la syntaxe reecrite devient la nouvelle source. */
  const commit = useCallback(
    (next: DiagramModel) => {
      updateAttributes({ source: writeDiagram(next) })
    },
    [updateAttributes]
  )

  const leaveEdit = useCallback(() => {
    setMode('view')
    setEditing(null)
    setLinkFrom(null)
  }, [])

  // Une fleche commencee doit pouvoir ne pas aboutir : sans cette sortie, le
  // seul moyen d'en sortir etait d'en tracer une dont on ne voulait pas.
  useEffect(() => {
    if (!linkFrom) return undefined

    const renounce = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLinkFrom(null)
    }

    document.addEventListener('keydown', renounce)
    return () => document.removeEventListener('keydown', renounce)
  }, [linkFrom])

  const onHandleClick = (handle: DiagramHandle): void => {
    if (!model) return

    // Une fleche en cours de tracage se termine sur la boite cliquee — y
    // compris celle d'ou elle part, qui devient alors une boucle.
    if (linkFrom && handle.kind === 'node') {
      const linked = connect(model, linkFrom, handle.key)
      if (linked) commit(linked.model)
      setLinkFrom(null)
      return
    }
    setEditing(handle.key)
  }

  const showSource = mode === 'source' || (mode === 'edit' && !model)

  return (
    <NodeViewWrapper
      className="note-diagram"
      // Le style s'adresse a chaque sorte de schema : une frise n'a pas les
      // memes besoins qu'une carte mentale, et se passe notamment du cadre.
      data-kind={model?.kind ?? kindOf(source)}
      data-selected={selected || undefined}
      data-editing={mode !== 'view' || undefined}
      contentEditable={false}
    >
      <div className="note-diagram-stage" ref={stage}>
        {model?.kind === 'mindmap' ? (
          <MindmapCanvas model={model} selected={Boolean(selected)} api={mapApi} />
        ) : (
          /* Le SVG vient de Mermaid, en mode strict : aucune etiquette n'y
             entre en HTML, tout y est du texte echappe. */
          <div className="note-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
        )}

        {mode === 'edit' && model && (
          <div className="note-diagram-layer">
            {handles.map((handle) => (
              <DiagramPart
                key={handle.key}
                handle={handle}
                model={model}
                editing={editing === handle.key}
                linking={linkFrom === handle.key}
                awaitingTarget={Boolean(linkFrom) && handle.kind === 'node'}
                onClick={() => onHandleClick(handle)}
                onRename={(label) => {
                  commit(renamePart(model, handle.key, label))
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
                onRemove={() => {
                  commit(removePart(model, handle.key))
                  setEditing(null)
                }}
                onAdd={() => {
                  const grown = addAfter(model, handle.key)
                  if (!grown) return
                  commit(grown.model)
                  setEditing(grown.created)
                }}
                onShape={(shape) => commit(setShape(model, handle.key, shape))}
                onLinkStyle={(link) => commit(setLink(model, handle.key, link))}
                onLink={() => {
                  setEditing(null)
                  setLinkFrom(handle.key)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {showSource && (
        <textarea
          className="note-diagram-source"
          defaultValue={source}
          autoFocus
          spellCheck={false}
          // Sans cela, chaque touche remonte a l'editeur, qui la prend pour
          // une frappe dans le document.
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') leaveEdit()
          }}
          onBlur={(event) => {
            updateAttributes({ source: event.target.value })
            leaveEdit()
          }}
        />
      )}

      {failure && (
        <div className="note-diagram-failure">
          <span className="note-diagram-failure-label">Schéma illisible</span>
          <pre className="note-diagram-failure-detail">{failure}</pre>
          {!showSource && <pre className="note-diagram-failure-source">{source}</pre>}
        </div>
      )}

      {mode === 'view' ? (
        <div className="note-diagram-tools">
          {/* Une carte qu'on a zoomee hors cadre n'a que ce bouton pour revenir. */}
          {isMind && (
            <button
              className="note-diagram-tool"
              onClick={() => mapApi.current?.fit()}
              title="Ramener la carte dans son cadre"
            >
              Recentrer
            </button>
          )}
          <button
            className="note-diagram-tool"
            onClick={() => setMode('edit')}
            title="Modifier ce schéma"
          >
            Modifier
          </button>
          <button className="block-cross" onClick={deleteNode} title="Supprimer ce schéma">
            ✕
          </button>
        </div>
      ) : (
        <div className="note-diagram-bar">
          <span className="note-diagram-hint">
            {linkFrom
              ? 'Clique la boîte d’arrivée — la même pour une boucle, échap pour renoncer'
              : model
                ? 'Clique un élément pour le renommer'
                : 'Ce type de schéma se modifie dans sa syntaxe'}
          </span>

          {linkFrom && (
            <button className="note-diagram-tool" onClick={() => setLinkFrom(null)}>
              Renoncer
            </button>
          )}

          {isMind && (
            <button className="note-diagram-tool" onClick={() => mapApi.current?.fit()}>
              Recentrer
            </button>
          )}

          {model && !showSource && !linkFrom && (
            <button
              className="note-diagram-tool"
              onClick={() => {
                const grown = addRoot(model)
                if (!grown) return
                commit(grown.model)
                setEditing(grown.created)
              }}
            >
              {addRootLabel(model)}
            </button>
          )}

          <button className="note-diagram-tool" onClick={leaveEdit}>
            Terminé
          </button>
        </div>
      )}
    </NodeViewWrapper>
  )
}

/**
 * Une zone cliquable posee sur une forme du dessin. Elle ne montre rien tant
 * qu'on ne la survole pas : le schema doit rester lisible pendant qu'on le
 * modifie.
 */
function DiagramPart({
  handle,
  model,
  editing,
  linking,
  awaitingTarget,
  onClick,
  onRename,
  onCancel,
  onRemove,
  onAdd,
  onShape,
  onLinkStyle,
  onLink
}: {
  handle: DiagramHandle
  model: DiagramModel
  editing: boolean
  linking: boolean
  awaitingTarget: boolean
  onClick: () => void
  onRename: (label: string) => void
  onCancel: () => void
  onRemove: () => void
  onAdd: () => void
  onShape: (shape: FlowShape) => void
  onLinkStyle: (link: string) => void
  onLink: () => void
}): React.JSX.Element {
  const label = partLabel(model, handle.key)
  const isFlowNode = model.kind === 'flowchart' && handle.kind === 'node'

  const box = {
    left: handle.x,
    top: handle.y,
    width: handle.width,
    height: handle.height
  }

  if (editing) {
    return (
      <div className="note-diagram-hit" data-editing style={box}>
        <input
          className="note-diagram-input"
          defaultValue={label}
          autoFocus
          spellCheck={false}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') onRename(event.currentTarget.value)
            if (event.key === 'Escape') onCancel()
          }}
          onBlur={(event) => onRename(event.target.value)}
        />

        {/* La forme se choisit pendant qu'on nomme : c'est le meme geste. Pas
            pour une carte mentale : markmap dessine tous ses noeuds pareil, et
            un reglage qui ne change rien a l'ecran serait pire qu'absent. Les
            formes deja ecrites dans la syntaxe restent lues et reecrites. */}
        {(isFlowNode || handle.kind === 'edge') && (
          <div className="note-diagram-shapes">
            {(isFlowNode
              ? FLOW_SHAPES.map((entry) => ({ key: entry.shape, label: entry.label }))
              : LINK_STYLES.map((entry) => ({ key: entry.link, label: entry.label }))
            ).map((entry) => (
              <button
                key={entry.key}
                className="note-diagram-shape"
                title={entry.label}
                // Le clic ne doit pas retirer le focus du champ, sinon la
                // saisie en cours serait validee avant d'etre finie.
                onMouseDown={(event) => {
                  event.preventDefault()
                  if (handle.kind === 'edge') onLinkStyle(entry.key)
                  else onShape(entry.key as FlowShape)
                }}
              >
                <Glyph name={entry.key} />
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="note-diagram-hit"
      data-kind={handle.kind}
      data-linking={linking || undefined}
      data-target={awaitingTarget || undefined}
      style={box}
      onClick={onClick}
      title={handle.kind === 'edge' ? 'Étiquette de la flèche' : label}
    >
      <span className="note-diagram-marks">
        {handle.extendable && (
          <button
            className="note-diagram-mark"
            title="Ajouter une suite"
            onClick={(event) => {
              event.stopPropagation()
              onAdd()
            }}
          >
            +
          </button>
        )}

        {isFlowNode && (
          <button
            className="note-diagram-mark"
            title="Tracer une flèche depuis cette boîte"
            onClick={(event) => {
              event.stopPropagation()
              onLink()
            }}
          >
            ↗
          </button>
        )}

        {handle.removable && (
          <button
            className="note-diagram-mark note-diagram-mark--remove"
            title="Supprimer"
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * Le noeud lui-meme. Il ne porte que sa syntaxe : l'image est recomposee a
 * l'affichage, jamais enregistree — ce qui garde la note en texte et permet de
 * changer le style de tous les schemas d'un seul reglage.
 */
export const Diagram = Node.create({
  name: 'diagram',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      source: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-source') ?? '',
        renderHTML: (attributes) => ({ 'data-source': attributes.source })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="diagram"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'diagram' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(DiagramView)
  }
})
