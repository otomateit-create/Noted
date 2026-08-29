/**
 * Un serveur MCP minimal, en HTTP local, pour le CLI Gemini.
 *
 * La generation de flashcards est agentique : l'agent appelle creer_carte, et
 * consulte le cours quand il est indexe. Sur les routes Claude, ces outils
 * passent par le moteur du SDK (createSdkMcpServer). Le CLI Gemini, lui, ne
 * parle pas ce protocole — mais il sait se connecter a un serveur MCP. On lui
 * en sert donc un, ephemere, sur 127.0.0.1 : il nait pour une fournee, expose
 * exactement les memes definitions d'outils, et meurt avec le sous-processus.
 *
 * Les definitions sont celles de sdk.tool() : leur handler rend deja un
 * CallToolResult MCP, et leur schema zod se traduit en JSON Schema par le
 * z.toJSONSchema natif de zod 4 — le meme zod qui a construit les schemas.
 * C'est pour cela qu'on n'utilise pas @modelcontextprotocol/sdk : sa version
 * embarquee convertit les schemas avec son propre zod, et un desaccord de
 * version (v3/v4) y casserait la conversion en silence. Ici, aucune dependance
 * de plus, et la conversion est celle de la bibliotheque d'origine.
 *
 * Le protocole servi est le « streamable HTTP » : des requetes JSON-RPC en
 * POST, une reponse JSON par requete. Pas de flux SSE — le serveur n'a rien a
 * pousser de lui-meme — et le client officiel accepte cette forme simple.
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'

/**
 * La forme structurelle d'une definition sdk.tool() du SDK Claude — redite ici
 * plutot qu'importee : le SDK est ESM-only et ce module compile en CommonJS,
 * et le type est assez petit pour que la redite reste lisible. Le handler
 * accepte « never » pour que n'importe quelle definition concrete s'y range ;
 * l'appel reel passe par les arguments valides par le schema de l'outil.
 */
export interface ServedTool {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: never, extra: unknown) => Promise<unknown>
}

export interface ToolServer {
  /** L'adresse a ecrire dans la configuration du CLI (httpUrl). */
  url: string
  close: () => Promise<void>
}

/** Un message JSON-RPC, tel qu'on le lit sans lui faire confiance. */
interface RpcMessage {
  jsonrpc?: unknown
  id?: number | string | null
  method?: unknown
  params?: {
    protocolVersion?: unknown
    name?: unknown
    arguments?: unknown
  }
}

/** Une fournee n'echange que du texte : inutile d'accepter plus gros. */
const MAX_BODY = 10 * 1024 * 1024

/** La revision du protocole qu'on sait servir, si le client n'en dit pas plus. */
const PROTOCOL_VERSION = '2025-06-18'

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('corps trop volumineux'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Le catalogue tools/list : chaque schema zod traduit en JSON Schema. Les
 * champs $schema et additionalProperties sont retires — le CLI retraduit ce
 * schema vers le format de declaration de fonctions de l'API Gemini, qui n'en
 * connait qu'un sous-ensemble, et ces deux-la n'y apportent rien.
 */
function toolCatalog(tools: ServedTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const schema = z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>
    delete schema['$schema']
    delete schema['additionalProperties']
    return { name: tool.name, description: tool.description, inputSchema: schema }
  })
}

/** Le resultat d'outil qui dit une faute au modele sans casser la session. */
function toolError(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true }
}

async function callTool(tools: ServedTool[], params: RpcMessage['params']): Promise<unknown> {
  const name = typeof params?.name === 'string' ? params.name : ''
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) return toolError(`Outil inconnu : « ${name} ».`)

  const parsed = z.object(tool.inputSchema).safeParse(params?.arguments ?? {})
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join(' ; ')
    return toolError(`Parametres invalides — ${details}. Corrige et rappelle l'outil.`)
  }

  try {
    return await tool.handler(parsed.data as never, {})
  } catch (error) {
    return toolError(`L'outil a echoue : ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Sert des definitions d'outils sdk.tool() sur un port local ephemere. A
 * fermer des que le sous-processus est termine : rien d'autre ne doit jamais
 * s'y connecter.
 */
export function serveTools(tools: ServedTool[]): Promise<ToolServer> {
  const sessionId = randomUUID()

  const respond = (response: ServerResponse, status: number, body?: unknown): void => {
    const headers: Record<string, string> = { 'mcp-session-id': sessionId }
    if (body !== undefined) headers['content-type'] = 'application/json'
    response.writeHead(status, headers)
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!request.url?.startsWith('/mcp')) return respond(response, 404)
    // Le client ouvre parfois un GET pour ecouter d'eventuels messages du
    // serveur : on n'en pousse aucun, et 405 le lui dit proprement.
    if (request.method === 'GET') return respond(response, 405)
    if (request.method === 'DELETE') return respond(response, 200)
    if (request.method !== 'POST') return respond(response, 405)

    let message: RpcMessage
    try {
      message = JSON.parse(await readBody(request)) as RpcMessage
    } catch {
      return respond(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'JSON illisible' }
      })
    }
    // Une notification (pas d'identifiant) n'attend pas de reponse.
    if (Array.isArray(message) || typeof message !== 'object' || message === null) {
      return respond(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'requete non prise en charge' }
      })
    }
    if (message.id === undefined || message.id === null) return respond(response, 202)

    const method = typeof message.method === 'string' ? message.method : ''
    let result: unknown
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion:
            typeof message.params?.protocolVersion === 'string'
              ? message.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'noted-flashcards', version: '1.0.0' }
        }
        break
      case 'tools/list':
        result = { tools: toolCatalog(tools) }
        break
      case 'tools/call':
        result = await callTool(tools, message.params)
        break
      case 'ping':
        result = {}
        break
      default:
        return respond(response, 200, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `methode non couverte : ${method}` }
        })
    }

    return respond(response, 200, { jsonrpc: '2.0', id: message.id, result })
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) respond(response, 500)
      else response.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('adresse du serveur MCP illisible'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}
