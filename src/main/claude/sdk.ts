/**
 * Chargement du SDK Claude Agent.
 *
 * Le SDK est distribue uniquement en ESM, alors que le processus principal est
 * compile en CommonJS : il ne peut donc pas etre importe statiquement. Un
 * `import` en tete de fichier serait traduit en `require()` a la compilation, et
 * l'application echouerait au premier message envoye.
 *
 * Le chargement est fait une fois et partage : ouvrir deux fois le module
 * couterait un second chargement pour rien.
 */

export type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<AgentSdk> | null = null

export function loadSdk(): Promise<AgentSdk> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}
