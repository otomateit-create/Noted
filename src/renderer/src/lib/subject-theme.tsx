/*
 * La thematique d'une matiere, deduite de son titre.
 *
 * Meme logique que subject-tint : rien n'est stocke, tout est derive du nom.
 * On reconnait quatre familles — finance, marketing, IA, blockchain — chacune
 * avec son symbole dessine maison et sa famille de degrades. Un titre qui
 * n'evoque rien tombe sur la famille generale (symbole livre ouvert).
 *
 * Chaque famille possede plusieurs degrades : deux matieres de finance ne
 * doivent pas etre identiques a l'ecran. Le degrade precis est choisi par un
 * melange positionnel du nom, comme la teinte des anciennes cartes.
 */

import type { JSX, ReactNode } from 'react'

export type SubjectThemeKey = 'finance' | 'marketing' | 'ai' | 'blockchain' | 'general'

export interface SubjectTheme {
  key: SubjectThemeKey
  /** Nom de la famille, montrable en libelle ou en title. */
  label: string
  /** Classes Tailwind du degrade (from/via/to), pretes pour bg-gradient-to-br. */
  gradient: string
  /** Le symbole de la famille, pose en haut a gauche de la carte. */
  icon: ReactNode
}

// ---------------------------------------------------------------------------
// Les symboles. Un seul langage graphique pour les cinq : trait 1.6, bouts
// ronds, pas d'aplat — la famille se reconnait a la silhouette, pas au style.
// ---------------------------------------------------------------------------

function symbol(children: ReactNode): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Finance : trois chandeliers en marche montante. */
const FINANCE_ICON = symbol(
  <>
    <path d="M5 11.2v1.6M5 18v1.5" />
    <rect x="3.4" y="12.8" width="3.2" height="5.2" rx="0.8" />
    <path d="M12 6.8v1.7M12 14.6v1.9" />
    <rect x="10.4" y="8.5" width="3.2" height="6.1" rx="0.8" />
    <path d="M19 2.8v1.5M19 10v1.8" />
    <rect x="17.4" y="4.3" width="3.2" height="5.7" rx="0.8" />
  </>
)

/** Marketing : porte-voix, deux ondes qui s'en echappent. */
const MARKETING_ICON = symbol(
  <>
    <path d="M3.2 10.4v3.6l11.3 4.2V6.2L3.2 10.4Z" />
    <path d="M6.8 14.9v2.7a1.9 1.9 0 0 0 3.8 0v-1.3" />
    <path d="M17.6 9.4a4.1 4.1 0 0 1 0 5.6" />
    <path d="M20.1 7.2a7.4 7.4 0 0 1 0 10" />
  </>
)

/** IA : un noeud central relie a quatre neurones. */
const AI_ICON = symbol(
  <>
    <circle cx="12" cy="12" r="2.6" />
    <circle cx="4.8" cy="5.6" r="1.7" />
    <circle cx="19.2" cy="5.6" r="1.7" />
    <circle cx="4.8" cy="18.4" r="1.7" />
    <circle cx="19.2" cy="18.4" r="1.7" />
    <path d="M10.1 10.3 6.1 6.7M13.9 10.3l4-3.6M10.1 13.7l-4 3.6M13.9 13.7l4 3.6" />
  </>
)

/** Blockchain : deux blocs cubiques, chaines l'un a l'autre. */
const BLOCKCHAIN_ICON = symbol(
  <>
    <path d="M7.5 2.6 11 4.7v4.1L7.5 10.9 4 8.8V4.7l3.5-2.1Z" />
    <path d="M4 4.7l3.5 2 3.5-2M7.5 6.7v4.2" />
    <path d="M16.5 13.1 20 15.2v4.1l-3.5 2.1-3.5-2.1v-4.1l3.5-2.1Z" />
    <path d="M13 15.2l3.5 2 3.5-2M16.5 17.2v4.2" />
    <path d="M11 11.5l2 2" />
  </>
)

/** Famille generale : le livre ouvert. */
const GENERAL_ICON = symbol(
  <>
    <path d="M12 6.1C10 4.4 7.6 4 4 4v14.2c3.6 0 6 .4 8 2 2-1.6 4.4-2 8-2V4c-3.6 0-6 .4-8 2.1Z" />
    <path d="M12 6.1v14.1" />
  </>
)

// ---------------------------------------------------------------------------
// Les familles et leurs degrades.
// ---------------------------------------------------------------------------

const FAMILIES: Record<SubjectThemeKey, Omit<SubjectTheme, 'gradient'> & { gradients: string[] }> =
  {
    finance: {
      key: 'finance',
      label: 'Finance',
      icon: FINANCE_ICON,
      gradients: [
        'from-emerald-600 via-emerald-700 to-emerald-800',
        'from-teal-600 via-teal-700 to-emerald-900',
        'from-emerald-700 via-green-800 to-slate-900'
      ]
    },
    marketing: {
      key: 'marketing',
      label: 'Marketing',
      icon: MARKETING_ICON,
      gradients: [
        'from-amber-500 via-orange-600 to-orange-700',
        'from-orange-500 via-amber-600 to-rose-700',
        'from-rose-500 via-orange-600 to-amber-700'
      ]
    },
    ai: {
      key: 'ai',
      label: 'Intelligence artificielle',
      icon: AI_ICON,
      gradients: [
        'from-purple-600 via-purple-700 to-purple-800',
        'from-violet-600 via-purple-700 to-indigo-900',
        'from-fuchsia-600 via-purple-700 to-purple-900'
      ]
    },
    blockchain: {
      key: 'blockchain',
      label: 'Blockchain',
      icon: BLOCKCHAIN_ICON,
      gradients: [
        'from-cyan-600 via-cyan-700 to-cyan-800',
        'from-sky-600 via-cyan-700 to-blue-900',
        'from-cyan-600 via-sky-700 to-indigo-900'
      ]
    },
    general: {
      key: 'general',
      label: 'Matière',
      icon: GENERAL_ICON,
      gradients: [
        'from-slate-700 via-slate-800 to-slate-900',
        'from-blue-600 via-blue-700 to-blue-800',
        'from-indigo-600 via-indigo-700 to-indigo-900',
        'from-gray-600 via-gray-700 to-gray-800'
      ]
    }
  }

// ---------------------------------------------------------------------------
// La detection. Les mots courts (ia, ai, ml…) exigent une frontiere de mot,
// sans quoi « maison » contiendrait « ai ». Le marketing passe avant la
// finance : « marketing » contient « market », qui sent pourtant la bourse.
// ---------------------------------------------------------------------------

const PATTERNS: ReadonlyArray<{ key: SubjectThemeKey; pattern: RegExp }> = [
  {
    key: 'marketing',
    pattern:
      /(marketing|brand|marque|communication|publicite|advertising|growth|vente|sales|consommateur|consumer|\bseo\b|\bcrm\b)/
  },
  {
    key: 'blockchain',
    pattern:
      /(blockchain|crypto|bitcoin|ethereum|web3|defi|smart contract|\bnft\b|\btokens?\b)/
  },
  {
    key: 'ai',
    pattern:
      /(intelligence artificielle|artificial intelligence|machine learning|deep learning|data science|neural|neurone|genai|gen ai|chatbot|prompt|\bia\b|\bai\b|\bml\b|\bllms?\b|\bnlp\b)/
  },
  {
    key: 'finance',
    pattern:
      /(financ|private equity|equity|invest|banking|banque|bank|fusion|acquisition|valuation|valorisation|compta|accounting|audit|capital|trading|bourse|market|hedge|venture|treasury|credit|dette|debt|obligation|portefeuille|portfolio|asset|immobilier|\blbo\b|\bdcf\b|\bm&a\b|\bvc\b|\bpe\b)/
  }
]

/** Minuscules et sans accents : « Publicité » doit matcher « publicite ». */
function normalize(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Meme melange positionnel que subject-tint : stable d'un lancement a l'autre. */
function hash(name: string): number {
  let value = 0
  for (let index = 0; index < name.length; index += 1) {
    value = (value * 31 + name.charCodeAt(index)) % 1000003
  }
  return value
}

export function detectSubjectTheme(title: string): SubjectTheme {
  const clean = normalize(title)
  const key = PATTERNS.find(({ pattern }) => pattern.test(clean))?.key ?? 'general'

  const family = FAMILIES[key]
  const { gradients, ...rest } = family
  return { ...rest, gradient: gradients[hash(title) % gradients.length] }
}
