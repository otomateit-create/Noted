/**
 * Electron enveloppe les erreurs levees dans le main process avant de les
 * renvoyer au renderer : « Error invoking remote method 'vault:create-subject':
 * Error: La matiere existe deja. » Ce prefixe technique n'a rien a faire sous
 * les yeux de l'utilisateur.
 */
export function readableError(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim()
  return cleaned || fallback
}
