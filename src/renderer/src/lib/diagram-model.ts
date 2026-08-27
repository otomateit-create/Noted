/**
 * Ce qu'il y a dans un schema, et comment le dessin renvoie a sa syntaxe.
 *
 * Un schema est du texte : de la syntaxe Mermaid dans un bloc ```mermaid. Pour
 * pouvoir le modifier a la souris plutot qu'a la ligne, il faut deux choses —
 * savoir lire cette syntaxe en une structure, et savoir retrouver, dans l'image
 * composee, la forme qui correspond a chaque element de cette structure.
 *
 * La seconde tient a une regularite de Mermaid, verifiee sur les trois types
 * que l'application propose :
 *
 *   carte mentale   les groupes portent « node_0 », « node_1 »… dans l'ordre
 *                   du parcours en profondeur, celui-la meme de la syntaxe ;
 *   schema de flux  l'identifiant de la boite est ecrit dans celui du groupe
 *                   (« flowchart-B-1 »), et les fleches sortent dans l'ordre
 *                   ou elles sont declarees ;
 *   frise           etapes et evenements sortent dans l'ordre, un evenement
 *                   se reconnaissant a l'enveloppe qui le porte.
 *
 * Rien n'est devine : ce qu'on ne sait pas relire reste dans la syntaxe et
 * ressort intact a l'ecriture. Un schema qu'on ne comprend pas s'affiche
 * toujours, il n'est simplement pas modifiable au clic.
 */

export type DiagramKind = 'mindmap' | 'flowchart' | 'timeline'

// ---------------------------------------------------------------------------
// Cartes mentales
// ---------------------------------------------------------------------------

/** Les formes qu'un noeud de carte mentale peut prendre. */
export type MindShape = 'plain' | 'square' | 'round' | 'circle' | 'bang' | 'cloud' | 'hexagon'

interface MindNode {
  label: string
  shape: MindShape
  /** Profondeur dans l'arbre. Le coeur vaut 0. */
  depth: number
  /** L'identifiant ecrit dans la syntaxe, quand il y en avait un. */
  id: string | null
}

export interface MindModel {
  kind: 'mindmap'
  /** Dans l'ordre du parcours en profondeur — celui des « node_N » du dessin. */
  nodes: MindNode[]
}

/** Les enveloppes de forme, de la plus specifique a la plus generale. */
const MIND_SHAPES: Array<{ shape: MindShape; open: string; close: string }> = [
  { shape: 'circle', open: '((', close: '))' },
  { shape: 'bang', open: '))', close: '((' },
  { shape: 'hexagon', open: '{{', close: '}}' },
  { shape: 'square', open: '[', close: ']' },
  { shape: 'cloud', open: ')', close: '(' },
  { shape: 'round', open: '(', close: ')' }
]

function parseMindText(text: string): { id: string | null; label: string; shape: MindShape } {
  for (const { shape, open, close } of MIND_SHAPES) {
    const start = text.indexOf(open)
    if (start === -1 || !text.endsWith(close)) continue

    const inner = text.slice(start + open.length, text.length - close.length)
    if (!inner) continue

    return {
      id: text.slice(0, start) || null,
      label: unquote(inner),
      shape
    }
  }

  return { id: null, label: unquote(text), shape: 'plain' }
}

function unquote(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed
}

/**
 * Un libelle a l'abri de l'analyseur. Mermaid coupe sur les crochets et les
 * parentheses : des qu'il y en a un, on met le texte entre guillemets, ce que
 * les trois grammaires acceptent.
 */
function quoteLabel(label: string): string {
  const clean = label.replace(/"/g, '”').replace(/\s*\n\s*/g, ' ').trim()
  // La barre oblique et l'esperluette s'ajoutent aux crochets : la premiere
  // ferme un parallelogramme, la seconde separe deux boites d'un meme trait.
  return /[[\](){}|<>#;&/\\]/.test(clean) ? `"${clean}"` : clean
}

function writeMindText(node: MindNode, index: number): string {
  const label = quoteLabel(node.label) || '…'
  if (node.shape === 'plain') return label

  const form = MIND_SHAPES.find((entry) => entry.shape === node.shape)
  if (!form) return label

  // Une forme se declare derriere un identifiant : sans lui, la grammaire ne
  // reconnait pas l'enveloppe.
  return `${node.id ?? `n${index}`}${form.open}${label}${form.close}`
}

function parseMindmap(lines: string[]): MindModel {
  const nodes: MindNode[] = []
  const indents: number[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    const indent = line.length - line.trimStart().length
    while (indents.length > 0 && indent <= indents[indents.length - 1]) indents.pop()
    const depth = indents.length
    indents.push(indent)

    nodes.push({ ...parseMindText(line.trim()), depth })
  }

  return { kind: 'mindmap', nodes }
}

function writeMindmap(model: MindModel): string {
  const body = model.nodes.map(
    (node, index) => `${'  '.repeat(node.depth + 1)}${writeMindText(node, index)}`
  )
  return ['mindmap', ...body].join('\n')
}

/** Le dernier descendant d'un noeud : tout ce qui suit et qui est plus profond. */
function subtreeEnd(model: MindModel, index: number): number {
  const depth = model.nodes[index].depth
  let end = index + 1
  while (end < model.nodes.length && model.nodes[end].depth > depth) end++
  return end
}

// ---------------------------------------------------------------------------
// Schemas de flux
// ---------------------------------------------------------------------------

export type FlowShape =
  | 'rect'
  | 'round'
  | 'stadium'
  | 'diamond'
  | 'circle'
  | 'hexagon'
  | 'subroutine'
  | 'cylinder'
  | 'doublecircle'
  | 'asymmetric'
  | 'parallelogram'
  | 'parallelogramAlt'
  | 'trapezoid'
  | 'trapezoidAlt'

interface FlowNode {
  id: string
  label: string
  shape: FlowShape
}

interface FlowEdge {
  from: string
  to: string
  label: string
  /** Le trait tel qu'ecrit : plein, pointille, epais. */
  link: string
}

export interface FlowModel {
  kind: 'flowchart'
  direction: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Ce qu'on n'a pas su relire — sous-graphes, styles — garde tel quel. */
  extra: string[]
}

/**
 * Toutes les enveloppes de boite que Mermaid connait, de la plus specifique a
 * la plus generale — l'ordre fait la lecture.
 *
 * Il n'est pas decoratif : `[(` doit passer avant `[`, sinon un cylindre se
 * relit en rectangle dont le libelle serait « (Banques) », et l'ecriture le
 * figerait sous cette forme. Un cours perdait ainsi la forme de ses boites au
 * premier clic. De meme `>` passe apres `[` pour qu'un crochet dans un libelle
 * ne se prenne pas pour une enveloppe asymetrique.
 */
const FLOW_SHAPES: Array<{ shape: FlowShape; open: string; close: string }> = [
  { shape: 'doublecircle', open: '(((', close: ')))' },
  { shape: 'subroutine', open: '[[', close: ']]' },
  { shape: 'cylinder', open: '[(', close: ')]' },
  { shape: 'stadium', open: '([', close: '])' },
  { shape: 'circle', open: '((', close: '))' },
  { shape: 'hexagon', open: '{{', close: '}}' },
  { shape: 'trapezoid', open: '[/', close: '\\]' },
  { shape: 'trapezoidAlt', open: '[\\', close: '/]' },
  { shape: 'parallelogram', open: '[/', close: '/]' },
  { shape: 'parallelogramAlt', open: '[\\', close: '\\]' },
  { shape: 'rect', open: '[', close: ']' },
  { shape: 'asymmetric', open: '>', close: ']' },
  { shape: 'diamond', open: '{', close: '}' },
  { shape: 'round', open: '(', close: ')' }
]

/**
 * Un trait entre deux boites, dans toutes les formes que Mermaid accepte.
 *
 *   corps    `--` plein, `==` epais, `-.` pointille, allonges a volonte
 *            (« ---> » ecarte les deux boites d'un rang de plus) ;
 *   pointes  rien, `>` la fleche, `o` le cercle, `x` la croix, et `<` du cote
 *            du depart pour un trait a double sens ;
 *   libelle  entre barres — « -->|oui| » — ou au milieu du trait, coupe en
 *            deux : « -- oui --> ».
 *
 * Les deux ecritures du libelle se relisent ; a l'ecriture on ne rend que la
 * premiere, la seule des deux qu'un trait de n'importe quelle sorte accepte.
 */
const FLOW_LINK =
  /([ox<]?)(?:(-{2,}|={2,}|-\.+)[ \t]+([^|]*?)[ \t]+(-{2,}|={2,}|\.+-)|(-{2,}|={2,}|-\.+-))([ox>]?)(?:\|([^|]*)\|)?/g

/**
 * Le trait sous sa forme courte, une fois son libelle mis de cote.
 *
 * La longueur est conservee : dans Mermaid, chaque tiret supplementaire pousse
 * la boite d'arrivee d'un rang de plus. Un « ----> » qu'on relirait « --> »
 * changerait la mise en page a chaque clic.
 */
function normaliseLink(body: string, head: string, tail: string): string {
  if (body.includes('.')) {
    const dots = Math.max(1, body.replace(/[^.]/g, '').length)
    return `${head}-${'.'.repeat(dots)}-${tail}`
  }

  // Sans pointe, le dernier signe appartient au trait lui-meme : « --> » tient
  // en deux tirets et une fleche, « --- » en trois tirets et rien.
  const bar = body.startsWith('=') ? '=' : '-'
  const width = Math.max(tail ? 2 : 3, body.replace(new RegExp(`[^${bar}]`, 'g'), '').length)
  return `${head}${bar.repeat(width)}${tail}`
}

function parseFlowRef(text: string): FlowNode | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  for (const { shape, open, close } of FLOW_SHAPES) {
    const start = trimmed.indexOf(open)
    if (start <= 0 || !trimmed.endsWith(close)) continue
    if (trimmed.length < start + open.length + close.length) continue

    const inner = trimmed.slice(start + open.length, trimmed.length - close.length)
    if (!inner) continue

    return { id: trimmed.slice(0, start).trim(), label: unquote(inner), shape }
  }

  // Une simple reference : l'identifiant sert aussi de libelle.
  if (!/^[\w-]+$/.test(trimmed)) return null
  return { id: trimmed, label: trimmed, shape: 'rect' }
}

function writeFlowNode(node: FlowNode): string {
  const form = FLOW_SHAPES.find((entry) => entry.shape === node.shape)
  const label = quoteLabel(node.label) || node.id

  // Une boite rectangulaire dont le libelle est son propre identifiant se
  // declare toute seule : « A » suffit, « A[A] » serait du bruit.
  if (!form || (node.shape === 'rect' && node.label === node.id)) return node.id
  return `${node.id}${form.open}${label}${form.close}`
}

/**
 * Les boites d'un cote d'un trait. Mermaid accepte « A & B --> C », qui relie
 * tout le groupe de gauche a tout celui de droite ; on relit ce raccourci en
 * fleches separees, la seule forme que l'editeur au clic sache designer.
 */
function parseFlowGroup(text: string): FlowNode[] | null {
  const group = text.split('&').map((piece) => parseFlowRef(piece))
  return group.every((ref): ref is FlowNode => ref !== null) ? group : null
}

function parseFlowchart(lines: string[], direction: string): FlowModel {
  const nodes = new Map<string, FlowNode>()
  const edges: FlowEdge[] = []
  const extra: string[] = []

  const remember = (node: FlowNode): void => {
    const known = nodes.get(node.id)
    // Une declaration porteuse d'un libelle l'emporte sur une simple mention.
    if (!known || (known.label === known.id && node.label !== node.id)) nodes.set(node.id, node)
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue

    FLOW_LINK.lastIndex = 0
    const links: Array<{ link: string; label: string }> = []
    const parts: string[] = []
    let cursor = 0
    let match: RegExpExecArray | null

    while ((match = FLOW_LINK.exec(line)) !== null) {
      parts.push(line.slice(cursor, match.index))

      const head = match[1] ?? ''
      const tail = match[6] ?? ''
      const halves = [match[2], match[4]].filter(Boolean) as string[]
      const body = match[5] ?? halves.sort((a, b) => b.length - a.length)[0] ?? '--'

      links.push({
        link: normaliseLink(body, head, tail),
        label: (match[7] ?? match[3] ?? '').trim()
      })
      cursor = match.index + match[0].length
    }
    parts.push(line.slice(cursor))

    if (links.length === 0) {
      const single = parseFlowGroup(line)
      if (single) single.forEach(remember)
      else extra.push(line)
      continue
    }

    // Une chaine « A --> B --> C » : chaque maillon devient une fleche.
    const groups = parts.map((part) => parseFlowGroup(part))
    if (!groups.every((group): group is FlowNode[] => group !== null)) {
      extra.push(line)
      continue
    }

    groups.flat().forEach(remember)
    for (let index = 0; index < links.length; index++) {
      for (const from of groups[index]) {
        for (const to of groups[index + 1]) {
          edges.push({
            from: from.id,
            to: to.id,
            label: links[index].label,
            link: links[index].link
          })
        }
      }
    }
  }

  return { kind: 'flowchart', direction, nodes: [...nodes.values()], edges, extra }
}

function writeFlowchart(model: FlowModel): string {
  const lines = [`flowchart ${model.direction}`]

  for (const node of model.nodes) lines.push(`  ${writeFlowNode(node)}`)
  for (const edge of model.edges) {
    const label = edge.label ? `|${quoteLabel(edge.label)}|` : ''
    lines.push(`  ${edge.from} ${edge.link}${label} ${edge.to}`)
  }
  for (const line of model.extra) lines.push(`  ${line}`)

  return lines.join('\n')
}

/**
 * L'identifiant que Mermaid donnera au trait numero `index`.
 *
 * Il le compose de ses deux extremites et d'un compteur — « L_A_B_0 » —, et ce
 * compteur suit une regle qu'on recopie ici telle quelle : zero pour le premier
 * trait d'une paire, puis le rang plus un, si bien que le deuxieme porte 2 et
 * jamais 1. C'est ce nom qui relie une fleche du dessin a sa ligne de syntaxe.
 */
function edgeDomId(model: FlowModel, index: number): string {
  const edge = model.edges[index]
  const before = model.edges
    .slice(0, index)
    .filter((entry) => entry.from === edge.from && entry.to === edge.to).length

  return `L_${edge.from}_${edge.to}_${before === 0 ? 0 : before + 1}`
}

/** Un identifiant libre, court et lisible dans la syntaxe. */
function freeFlowId(model: FlowModel): string {
  const taken = new Set(model.nodes.map((node) => node.id))
  for (let index = 1; index < 500; index++) {
    const candidate = `N${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `N${taken.size + 1}`
}

// ---------------------------------------------------------------------------
// Frises
// ---------------------------------------------------------------------------

interface TimePeriod {
  label: string
  events: string[]
}

export interface TimeModel {
  kind: 'timeline'
  title: string
  periods: TimePeriod[]
}

/**
 * Le deux-points separe les elements d'une ligne de frise : ecrit tel quel
 * dans un libelle, il le couperait en deux. Mermaid a pour cela son propre
 * echappement, « #58; », qu'il rend en caractere — verifie a l'ecran, la ou
 * l'entite HTML « &#58; » ressortait telle quelle.
 */
const TIME_COLON = '#58;'

function encodeTimeLabel(label: string): string {
  return label.replace(/\s*\n\s*/g, ' ').replace(/:/g, TIME_COLON).trim()
}

function decodeTimeLabel(label: string): string {
  return label.replace(/#58;/g, ':').trim()
}

function parseTimeline(lines: string[]): TimeModel {
  const model: TimeModel = { kind: 'timeline', title: '', periods: [] }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue

    if (/^title\s/i.test(line)) {
      model.title = line.slice(5).trim()
      continue
    }

    const segments = line.split(':').map((segment) => decodeTimeLabel(segment))

    // Une ligne qui commence par deux-points prolonge l'etape precedente.
    if (segments[0] === '' && model.periods.length > 0) {
      model.periods[model.periods.length - 1].events.push(
        ...segments.slice(1).filter(Boolean)
      )
      continue
    }

    model.periods.push({
      label: segments[0],
      events: segments.slice(1).filter(Boolean)
    })
  }

  return model
}

function writeTimeline(model: TimeModel): string {
  const lines = ['timeline']
  if (model.title.trim()) lines.push(`  title ${encodeTimeLabel(model.title)}`)

  for (const period of model.periods) {
    const parts = [encodeTimeLabel(period.label) || '…', ...period.events.map(encodeTimeLabel)]
    lines.push(`  ${parts.join(' : ')}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Lecture et ecriture
// ---------------------------------------------------------------------------

export type DiagramModel = MindModel | FlowModel | TimeModel

/** Rend la structure d'un schema, ou null si sa syntaxe n'est pas des trois. */
export function parseDiagram(source: string): DiagramModel | null {
  const lines = source.replace(/\r/g, '').split('\n')
  const first = lines.find((line) => line.trim())?.trim() ?? ''
  const body = lines.slice(lines.findIndex((line) => line.trim()) + 1)

  if (/^mindmap\b/.test(first)) return parseMindmap(body)
  if (/^timeline\b/.test(first)) return parseTimeline(body)

  const flow = /^(?:flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/.exec(first)
  if (flow) {
    // Un sous-graphe encadre des boites, et cet encadrement se declare en deux
    // lignes qui entourent les leurs. L'ecriture, elle, rassemble les boites
    // puis les fleches puis le reste : rendu tel quel, le cadre se retrouverait
    // apres son contenu et le schema ne compilerait plus. Tant qu'on ne sait
    // pas replacer ces deux lignes, un tel schema se modifie dans son texte.
    if (body.some((line) => /^\s*subgraph\b/.test(line))) return null
    return parseFlowchart(body, flow[1])
  }

  return null
}

export function writeDiagram(model: DiagramModel): string {
  switch (model.kind) {
    case 'mindmap':
      return writeMindmap(model)
    case 'flowchart':
      return writeFlowchart(model)
    case 'timeline':
      return writeTimeline(model)
  }
}

// ---------------------------------------------------------------------------
// Les gestes
// ---------------------------------------------------------------------------

/**
 * Ce qu'on peut designer dans un dessin. La cle voyage de la structure a
 * l'image et retour : c'est elle qui fait le lien entre une forme cliquee et
 * la ligne de syntaxe a modifier.
 */
export type PartKey = string

export function renamePart(model: DiagramModel, key: PartKey, label: string): DiagramModel {
  const next = structuredClone(model)
  const [kind, first, second] = key.split(':')

  if (next.kind === 'mindmap' && kind === 'node') {
    const node = next.nodes[Number(first)]
    if (node) node.label = label
  } else if (next.kind === 'flowchart' && kind === 'node') {
    const node = next.nodes.find((entry) => entry.id === first)
    if (node) node.label = label
  } else if (next.kind === 'flowchart' && kind === 'edge') {
    const edge = next.edges[Number(first)]
    if (edge) edge.label = label
  } else if (next.kind === 'timeline' && kind === 'period') {
    const period = next.periods[Number(first)]
    if (period) period.label = label
  } else if (next.kind === 'timeline' && kind === 'event') {
    const period = next.periods[Number(first)]
    if (period) period.events[Number(second)] = label
  } else if (next.kind === 'timeline' && kind === 'title') {
    next.title = label
  }

  return next
}

export function removePart(model: DiagramModel, key: PartKey): DiagramModel {
  const next = structuredClone(model)
  const [kind, first, second] = key.split(':')

  if (next.kind === 'mindmap' && kind === 'node') {
    const index = Number(first)
    // Le coeur ne se retire pas : une carte mentale sans racine n'existe pas.
    if (index > 0 && index < next.nodes.length) {
      next.nodes.splice(index, subtreeEnd(next, index) - index)
    }
  } else if (next.kind === 'flowchart' && kind === 'node') {
    next.nodes = next.nodes.filter((node) => node.id !== first)
    next.edges = next.edges.filter((edge) => edge.from !== first && edge.to !== first)
  } else if (next.kind === 'flowchart' && kind === 'edge') {
    next.edges.splice(Number(first), 1)
  } else if (next.kind === 'timeline' && kind === 'period') {
    next.periods.splice(Number(first), 1)
  } else if (next.kind === 'timeline' && kind === 'event') {
    next.periods[Number(first)]?.events.splice(Number(second), 1)
  }

  return next
}

/**
 * Ajoute une suite a l'element designe, et rend la cle du nouvel element pour
 * que l'editeur y place aussitot le curseur — on ajoute pour ecrire.
 */
export function addAfter(
  model: DiagramModel,
  key: PartKey
): { model: DiagramModel; created: PartKey } | null {
  const next = structuredClone(model)
  const [kind, first] = key.split(':')

  if (next.kind === 'mindmap' && kind === 'node') {
    const index = Number(first)
    const parent = next.nodes[index]
    if (!parent) return null

    const at = subtreeEnd(next, index)
    next.nodes.splice(at, 0, { label: 'Nouveau', shape: 'plain', depth: parent.depth + 1, id: null })
    return { model: next, created: `node:${at}` }
  }

  if (next.kind === 'flowchart' && kind === 'node') {
    const id = freeFlowId(next)
    next.nodes.push({ id, label: 'Nouvelle etape', shape: 'rect' })
    next.edges.push({ from: first, to: id, label: '', link: '-->' })
    return { model: next, created: `node:${id}` }
  }

  if (next.kind === 'timeline' && kind === 'period') {
    const period = next.periods[Number(first)]
    if (!period) return null
    period.events.push('Nouvel evenement')
    return { model: next, created: `event:${first}:${period.events.length - 1}` }
  }

  return null
}

/** Une etape de plus au bout de la frise, ou une boite libre dans un flux. */
export function addRoot(model: DiagramModel): { model: DiagramModel; created: PartKey } | null {
  const next = structuredClone(model)

  if (next.kind === 'timeline') {
    next.periods.push({ label: 'Nouvelle etape', events: [] })
    return { model: next, created: `period:${next.periods.length - 1}` }
  }

  if (next.kind === 'mindmap') {
    if (next.nodes.length === 0) return null
    next.nodes.push({ label: 'Nouvelle branche', shape: 'plain', depth: 1, id: null })
    return { model: next, created: `node:${next.nodes.length - 1}` }
  }

  if (next.kind === 'flowchart') {
    const id = freeFlowId(next)
    next.nodes.push({ id, label: 'Nouvelle etape', shape: 'rect' })
    return { model: next, created: `node:${id}` }
  }

  return null
}

/**
 * Relie deux boites d'un schema de flux.
 *
 * Aucune paire n'est refusee : une boite peut se relier a elle-meme — une
 * etape qui se repete —, revenir en arriere, ou recevoir un second trait de
 * la meme boite quand deux conditions differentes y menent. Mermaid dessine
 * les trois ; le seul refus possible serait le notre, et il n'aurait pas de
 * raison d'etre.
 */
export function connect(
  model: DiagramModel,
  fromKey: PartKey,
  toKey: PartKey,
  link = '-->'
): { model: DiagramModel; created: PartKey } | null {
  if (model.kind !== 'flowchart') return null

  const from = fromKey.split(':')[1]
  const to = toKey.split(':')[1]
  if (!from || !to) return null

  const next = structuredClone(model)
  next.edges.push({ from, to, label: '', link })
  return { model: next, created: `edge:${next.edges.length - 1}` }
}

/** Change la forme d'une boite — de flux comme de carte mentale. */
export function setShape(
  model: DiagramModel,
  key: PartKey,
  shape: FlowShape | MindShape
): DiagramModel {
  const next = structuredClone(model)

  if (next.kind === 'flowchart') {
    const node = next.nodes.find((entry) => entry.id === key.split(':')[1])
    if (node) node.shape = shape as FlowShape
    return next
  }

  if (next.kind === 'mindmap') {
    const node = next.nodes[Number(key.split(':')[1])]
    if (node) node.shape = shape as MindShape
    return next
  }

  return model
}

/** Change le trait d'une fleche : plein, pointille, epais, a double sens. */
export function setLink(model: DiagramModel, key: PartKey, link: string): DiagramModel {
  if (model.kind !== 'flowchart') return model

  const next = structuredClone(model)
  const edge = next.edges[Number(key.split(':')[1])]
  if (edge) edge.link = link
  return next
}

/** Le libelle actuel d'un element, pour pre-remplir le champ de saisie. */
export function partLabel(model: DiagramModel, key: PartKey): string {
  const [kind, first, second] = key.split(':')

  if (model.kind === 'mindmap' && kind === 'node') return model.nodes[Number(first)]?.label ?? ''
  if (model.kind === 'flowchart' && kind === 'node') {
    return model.nodes.find((node) => node.id === first)?.label ?? ''
  }
  if (model.kind === 'flowchart' && kind === 'edge') return model.edges[Number(first)]?.label ?? ''
  if (model.kind === 'timeline' && kind === 'title') return model.title
  if (model.kind === 'timeline' && kind === 'period') return model.periods[Number(first)]?.label ?? ''
  if (model.kind === 'timeline' && kind === 'event') {
    return model.periods[Number(first)]?.events[Number(second)] ?? ''
  }

  return ''
}

// ---------------------------------------------------------------------------
// Du dessin a la syntaxe
// ---------------------------------------------------------------------------

/** Une zone cliquable du dessin, reperee dans le repere du conteneur. */
export interface DiagramHandle {
  key: PartKey
  /** Coordonnees relatives au cadre du schema, en pixels. */
  x: number
  y: number
  width: number
  height: number
  /** Une fleche se renomme et se coupe, mais ne recoit pas d'enfant. */
  kind: 'node' | 'edge' | 'period' | 'event' | 'title'
  /** Faux pour le coeur d'une carte mentale, qui ne se supprime pas. */
  removable: boolean
  /** Vrai quand l'element accepte une suite. */
  extendable: boolean
}

/**
 * Retrouve, dans l'image composee, la zone de chaque element de la structure.
 *
 * `frame` est le rectangle du cadre qui porte le SVG : toutes les positions
 * sont exprimees relativement a lui, pour que les zones se posent en absolu
 * dans ce cadre et suivent le defilement sans recalcul.
 */
export function locateParts(
  model: DiagramModel,
  svg: SVGSVGElement,
  frame: DOMRect
): DiagramHandle[] {
  const handles: DiagramHandle[] = []

  const push = (
    element: Element,
    key: PartKey,
    kind: DiagramHandle['kind'],
    options: { removable?: boolean; extendable?: boolean } = {}
  ): void => {
    const box = element.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return

    handles.push({
      key,
      kind,
      x: box.x - frame.x,
      y: box.y - frame.y,
      width: box.width,
      height: box.height,
      removable: options.removable ?? true,
      extendable: options.extendable ?? false
    })
  }

  if (model.kind === 'mindmap') {
    // « node_N » porte le rang du noeud dans le parcours en profondeur, qui
    // est aussi son rang dans la syntaxe.
    for (const group of Array.from(svg.querySelectorAll('g.mindmap-node'))) {
      const rank = /node_(\d+)$/.exec(group.id)
      if (!rank) continue

      const index = Number(rank[1])
      if (!model.nodes[index]) continue
      push(group, `node:${index}`, 'node', { removable: index > 0, extendable: true })
    }
    return handles
  }

  if (model.kind === 'flowchart') {
    for (const group of Array.from(svg.querySelectorAll('g.node'))) {
      // « <dessin>-flowchart-<identifiant>-<rang> » : on reprend l'identifiant.
      const found = /-flowchart-(.+)-\d+$/.exec(group.id)
      const id = found?.[1]
      if (!id || !model.nodes.some((node) => node.id === id)) continue
      push(group, `node:${id}`, 'node', { extendable: true })
    }

    // Chaque trait porte son propre identifiant, forme de ses deux extremites.
    // On le reconstruit plutot que de compter les chemins dans l'ordre : une
    // seule ligne de syntaxe qu'on n'aurait pas su relire — un sous-graphe, un
    // trait d'une sorte inconnue — decalait tout le reste, et les poignees se
    // posaient alors sur la mauvaise fleche.
    const paths = Array.from(svg.querySelectorAll<SVGPathElement>('path.flowchart-link'))
    const labels = Array.from(svg.querySelectorAll<SVGGElement>('.edgeLabels > g.edgeLabel'))

    model.edges.forEach((edge, index) => {
      const wanted = edgeDomId(model, index)
      const path = paths.find((entry) => entry.id.endsWith(`-${wanted}`)) ?? paths[index]
      if (!path) return

      // Une fleche qui porte un mot se designe par ce mot : la poignee se pose
      // dessus, et non au milieu du trait ou Mermaid n'a rien ecrit. Les
      // etiquettes sortent dans l'ordre des fleches, ce qui ne suffirait pas a
      // s'y fier — on ne prend donc celle-ci que si son texte est bien celui
      // qu'on attend. Sinon, le milieu du trait, qui ne ment jamais.
      const written = labels[index]?.textContent?.trim()
      const box =
        edge.label && written === edge.label ? labels[index].getBoundingClientRect() : null

      if (box && box.width > 0) {
        handles.push({
          key: `edge:${index}`,
          kind: 'edge',
          x: box.x - frame.x - 6,
          y: box.y - frame.y - 3,
          width: box.width + 12,
          height: box.height + 6,
          removable: true,
          extendable: false
        })
        return
      }

      const matrix = path.getScreenCTM()
      if (!matrix) return

      const middle = path.getPointAtLength(path.getTotalLength() / 2)
      const point = svg.createSVGPoint()
      point.x = middle.x
      point.y = middle.y

      const screen = point.matrixTransform(matrix)
      handles.push({
        key: `edge:${index}`,
        kind: 'edge',
        x: screen.x - frame.x - 26,
        y: screen.y - frame.y - 11,
        width: 52,
        height: 22,
        removable: true,
        extendable: false
      })
    })

    return handles
  }

  // Frise : etapes et evenements se suivent, un evenement se reconnaissant a
  // l'enveloppe qui le porte.
  const title = svg.querySelector('.timelineTitle')
  if (title) push(title, 'title', 'title', { removable: false })

  let period = -1
  let event = 0

  for (const group of Array.from(svg.querySelectorAll('g.timeline-node'))) {
    if (group.closest('g.eventWrapper')) {
      if (period < 0 || !model.periods[period]?.events[event]) continue
      push(group, `event:${period}:${event}`, 'event')
      event++
    } else {
      period++
      event = 0
      if (!model.periods[period]) continue
      push(group, `period:${period}`, 'period', { extendable: true })
    }
  }

  return handles
}
