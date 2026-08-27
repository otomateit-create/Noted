import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PromptId, PromptSetting } from '@shared/types'
import '../styles/hub.css'
import '../styles/settings.css'

/**
 * L'ecran Parametres : le prompt de chaque agent, modifiable.
 *
 * Le champ montre le fichier du vault (Prompts/<agent>.md) et l'enregistre :
 * il n'y a pas d'autre copie du prompt quelque part. Le texte livre avec
 * l'application reste a portee par « Restaurer », et ce que l'application
 * ajoute d'elle-meme (le plan du cours, la carte revisee, les surlignages) est
 * montre sous chaque champ : personne ne doit croire l'avoir efface en
 * effacant la ligne qui en parlait.
 *
 * Les brouillons vont dans le stockage local a chaque frappe. Un prompt se
 * reecrit en plusieurs minutes ; cliquer « Matieres » entre-temps ne doit pas
 * emporter le travail.
 */

/** Ou dort un brouillon en cours de frappe, en attendant son enregistrement. */
function draftKey(id: PromptId): string {
  return `noted.prompt.draft.${id}`
}

export default function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<PromptSetting[] | null>(null)

  const load = useCallback(() => {
    window.noted.reglages
      .prompts()
      .then(setSettings)
      .catch(() => setSettings([]))
  }, [])

  useEffect(load, [load])

  if (settings === null) {
    return <div className="hub-page" />
  }

  return (
    <div className="hub-page">
      <div className="hub-page-inner">
        <h1 className="hub-page-title">Paramètres</h1>
        <p className="hub-page-lede">
          Le prompt de chaque agent. Ce qui est écrit ici fait foi : le texte part tel quel au
          modèle dès le prochain message, sans redémarrer l'application. Il n'y en a pas d'autre
          copie — ce champ est le fichier <code>Prompts/</code> de ton dossier Noted, ouvrable
          aussi dans Obsidian.
        </p>

        {settings.map((setting) => (
          <PromptCard key={setting.id} setting={setting} onSaved={setSettings} />
        ))}
      </div>
    </div>
  )
}

interface PromptCardProps {
  setting: PromptSetting
  onSaved: (settings: PromptSetting[]) => void
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function PromptCard({ setting, onSaved }: PromptCardProps): React.JSX.Element {
  // Le brouillon prime sur le texte enregistre : c'est la frappe interrompue
  // qu'on retrouve en revenant, pas la version d'avant.
  const [draft, setDraft] = useState(
    () => window.localStorage.getItem(draftKey(setting.id)) ?? setting.texte
  )
  const [state, setState] = useState<SaveState>('idle')
  const [annexeOpen, setAnnexeOpen] = useState(false)

  const dirty = draft !== setting.texte

  useEffect(() => {
    if (dirty) window.localStorage.setItem(draftKey(setting.id), draft)
    else window.localStorage.removeItem(draftKey(setting.id))
  }, [dirty, draft, setting.id])

  // L'accuse de reception s'efface tout seul : un « Enregistre » qui reste
  // affiche ne dit plus rien du geste suivant.
  useEffect(() => {
    if (state !== 'saved') return undefined
    const timer = setTimeout(() => setState('idle'), 1800)
    return () => clearTimeout(timer)
  }, [state])

  const write = useCallback(
    async (texte: string | null) => {
      setState('saving')
      try {
        const next = await window.noted.reglages.setPrompt(setting.id, texte)
        window.localStorage.removeItem(draftKey(setting.id))
        onSaved(next)
        setDraft(next.find((entry) => entry.id === setting.id)?.texte ?? draft)
        setState('saved')
      } catch {
        setState('error')
      }
    },
    [setting.id, onSaved, draft]
  )

  const save = useCallback(() => {
    if (!dirty || !draft.trim()) return
    void write(draft)
  }, [dirty, draft, write])

  const restore = useCallback(() => {
    // Rien a perdre tant que le prompt n'a pas ete regle : la question ne se
    // pose que quand un texte ecrit a la main va disparaitre.
    if (
      setting.personnalise &&
      !window.confirm(`Rendre « ${setting.label} » au prompt livré avec l'application ?`)
    ) {
      return
    }
    setDraft(setting.defaut)
    void write(null)
  }, [setting, write])

  const characters = useMemo(() => draft.trim().length.toLocaleString('fr-FR'), [draft])

  // Les reperes presents dans ce qui est tape, et non dans le texte livre :
  // les avoir effaces doit faire disparaitre l'explication qui va avec.
  const markers = useMemo(
    () => [...new Set(draft.match(/\{\{\w+\}\}/g) ?? [])],
    [draft]
  )

  return (
    <section className="prompt-card">
      <header className="prompt-head">
        <h2 className="prompt-name">{setting.label}</h2>
        {setting.personnalise && <span className="prompt-badge">Personnalisé</span>}
        {dirty && <span className="prompt-badge prompt-badge-dirty">Non enregistré</span>}
      </header>

      <p className="prompt-description">{setting.description}</p>

      <textarea
        className="prompt-editor"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.metaKey && event.key === 's') {
            event.preventDefault()
            event.stopPropagation()
            save()
          }
        }}
        aria-label={`Prompt de ${setting.label}`}
      />

      {markers.length > 0 && (
        <p className="prompt-markers">
          {markers.join(' et ')} {markers.length > 1 ? 'sont remplacés' : 'est remplacé'} à l'envoi
          par la légende des surlignages et la liste des habillages de tableau, que l'application
          tient à jour. Les effacer fige ces listes dans ton texte.
        </p>
      )}

      <div className="prompt-annexe">
        <button
          className="prompt-annexe-toggle"
          onClick={() => setAnnexeOpen((open) => !open)}
          aria-expanded={annexeOpen}
        >
          <span className="prompt-annexe-chevron" data-open={annexeOpen}>
            ›
          </span>
          Ce que l'application ajoute d'elle-même
        </button>

        {annexeOpen && (
          <div className="prompt-annexe-body">
            <p className="prompt-annexe-lede">
              Ces blocs ne se modifient pas : ce sont les données du moment, pas des consignes.
              Les voici tels qu'ils partent au modèle, sur un cours et une carte d'exemple.
            </p>
            {setting.annexes.map((annexe) => (
              <div key={annexe.titre} className="prompt-annexe-block">
                <span className="prompt-annexe-titre">{annexe.titre}</span>
                <pre className="prompt-annexe-texte">{annexe.texte}</pre>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="prompt-actions">
        <button
          className="prompt-file"
          onClick={() => window.noted.vault.reveal(setting.chemin)}
          title={setting.chemin}
        >
          Prompts/{setting.id}.md
        </button>

        <span className="prompt-count">{characters} caractères</span>

        <button
          className="prompt-restore"
          onClick={restore}
          disabled={!setting.personnalise && !dirty}
        >
          Restaurer le défaut
        </button>

        <button
          className="prompt-save"
          data-state={state}
          onClick={save}
          disabled={!dirty || !draft.trim() || state === 'saving'}
        >
          {state === 'error'
            ? 'Échec — réessayer'
            : state === 'saved'
              ? 'Enregistré'
              : 'Enregistrer'}
        </button>
      </footer>
    </section>
  )
}
