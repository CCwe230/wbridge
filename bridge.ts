/**
 * WorkBuddy -> Claude Code bridge.
 *
 * Reuses dsh-xdpool's account discovery, at-rest decryption and loopback shim,
 * and exposes an Anthropic Messages API on 127.0.0.1 for Claude Code. The shim
 * supplies account rotation/failover; this process only translates protocols.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WorkBuddyAccountPool } from './vendor/dsh-xdpool/src/accounts.ts'
import { WorkBuddyCatalog } from './vendor/dsh-xdpool/src/catalog.ts'
import { WorkBuddyUpstreamClient } from './vendor/dsh-xdpool/src/upstream.ts'
import { createWorkBuddyShim } from './vendor/dsh-xdpool/src/shim.ts'
import { estimateTokens, mapAnthropicRequest } from './anthropic.ts'
import { createSseParser, TurnTranslator } from './stream.ts'

const HOST = '127.0.0.1'
const PORT = Number(process.env['WB_PORT'] ?? '8327')
const TOKEN = process.env['WB_TOKEN'] ?? 'xdpool-local'
const DEFAULT_MODEL = process.env['WB_MODEL'] ?? 'deepseek-v4.1-flash'
const RESCAN_MS = Number(process.env['WB_RESCAN_MS'] ?? '300000')
const MAX_BODY_BYTES = 32 * 1024 * 1024

const logger = {
  info: (...args: unknown[]) => log(...args),
  warn: (...args: unknown[]) => log('[warn]', ...args),
  error: (...args: unknown[]) => log('[error]', ...args),
}

function log(...args: unknown[]): void {
  console.error(`[${new Date().toISOString()}] xdpool-bridge:`, ...args)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const NEUTRAL_SYSTEM = 'You are a helpful AI assistant.'

function withNeutralSystem(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body['messages']) ? [...(body['messages'] as unknown[])] : []
  const first = messages[0]
  if (typeof first === 'object' && first !== null && (first as Record<string, unknown>)['role'] === 'system') {
    messages[0] = { role: 'system', content: NEUTRAL_SYSTEM }
  } else {
    messages.unshift({ role: 'system', content: NEUTRAL_SYSTEM })
  }
  return { ...body, messages }
}

function withoutTools(body: Record<string, unknown>): Record<string, unknown> {
  const { tools: _tools, tool_choice: _toolChoice, ...rest } = body
  return rest
}

const client = new WorkBuddyUpstreamClient()
const pool = new WorkBuddyAccountPool({ client, persistent: true, logger })
const catalog = new WorkBuddyCatalog('cn')

let scanning = false

/** Discover accounts and refresh the live model catalog. Never throws. */
async function seed(): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const accounts = await pool.scan()
    log(`accounts: ${accounts.length}`)
    for (const account of accounts) {
      log(`  - ${account.label ?? account.id} (${account.id})`)
    }
    if (accounts.length === 0) {
      log('[warn] no WorkBuddy account found — sign in with the desktop app and leave it installed')
      return
    }
    try {
      const models = await client.fetchModels(accounts[0]!.credential)
      catalog.updateFromUpstream(models)
      log(`catalog: ${models.length} live model(s)`)
    } catch (error) {
      log(`[warn] live model catalog unavailable (${errorMessage(error)}); keeping the static fallback`)
    }
  } catch (error) {
    log(`[warn] account scan failed: ${errorMessage(error)}`)
  } finally {
    scanning = false
  }
}

function bearerOk(header: string | undefined): boolean {
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
  if (match === null) return false
  const given = Buffer.from(match[1] as string)
  const expected = Buffer.from(TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function authorized(req: IncomingMessage): boolean {
  const bearer = bearerOk(req.headers.authorization)
  if (bearer) return true
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' && apiKey === TOKEN
}

/** Headers the desktop app's renderer needs when it calls the gateway directly. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
} as const

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS })
  res.end(JSON.stringify(body))
}

function errorTypeOf(status: number, message: string): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (/context|too long|11115|token/iu.test(message)) return 'invalid_request_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function writeClientError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { type: 'error', error: { type: errorTypeOf(status, message), message } })
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function modelRows(): { id: string; name: string; maxOutputTokens?: number }[] {
  return catalog.current().map(model => ({
    id: model.id,
    name: model.name,
    maxOutputTokens: model.maxOutputTokens,
  }))
}

/** Rebuild a complete Anthropic message from collected stream events. */
function eventsToMessage(events: { event: string; data: any }[]): any {
  let message: any = {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  const blocks = new Map<number, any>()
  const partial = new Map<number, string>()

  for (const { event, data } of events) {
    if (event === 'message_start') {
      message = { ...data.message, content: [] }
    } else if (event === 'content_block_start') {
      blocks.set(data.index, { ...data.content_block })
      partial.set(data.index, '')
    } else if (event === 'content_block_delta') {
      const block = blocks.get(data.index)
      if (block === undefined) continue
      if (data.delta?.type === 'text_delta') block.text += data.delta.text
      else if (data.delta?.type === 'input_json_delta') {
        partial.set(data.index, (partial.get(data.index) ?? '') + data.delta.partial_json)
      }
    } else if (event === 'content_block_stop') {
      const block = blocks.get(data.index)
      if (block?.type === 'tool_use') {
        const raw = partial.get(data.index) ?? ''
        try {
          block.input = raw === '' ? {} : JSON.parse(raw)
        } catch {
          block.input = {}
        }
      }
    } else if (event === 'message_delta') {
      message.stop_reason = data.delta?.stop_reason ?? null
      message.stop_sequence = data.delta?.stop_sequence ?? null
      message.usage = { ...message.usage, ...(data.usage ?? {}) }
    }
  }

  message.content = [...blocks.keys()].sort((a, b) => a - b).map(index => blocks.get(index))
  return message
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now()
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readBody(req))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object')
    body = parsed as Record<string, unknown>
  } catch (error) {
    writeClientError(res, 400, `invalid request body: ${errorMessage(error)}`)
    return
  }

  const rows = modelRows()
  const knownModels = new Set(rows.map(row => row.id))
  const requested = typeof body['model'] === 'string' ? body['model'] : ''
  const row = rows.find(candidate => candidate.id === requested)
    ?? rows.find(candidate => candidate.id === DEFAULT_MODEL)

  const mapped = mapAnthropicRequest(body, {
    defaultModel: DEFAULT_MODEL,
    knownModels,
    maxOutputTokens: row?.maxOutputTokens,
  })
  const inputTokens = estimateTokens(body)
  const wantsStream = body['stream'] !== false

  if (process.env['WB_DEBUG_BODY'] === '1') {
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(new URL('./bridge-debug.json', import.meta.url), JSON.stringify(mapped, null, 2))
    } catch (error) {
      log(`[warn] could not write debug body: ${errorMessage(error)}`)
    }
  }

  const controller = new AbortController()
  let aborted = false
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true
      controller.abort()
    }
  })

  const mappedRecord = mapped as unknown as Record<string, unknown>
  const attempts = [
    { name: 'sanitised', body: mappedRecord },
    { name: 'neutral-system', body: withNeutralSystem(mappedRecord) },
    { name: 'neutral-system-no-tools', body: withoutTools(withNeutralSystem(mappedRecord)) },
  ]

  let upstream: Response | undefined
  let failureText = ''
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index] as { name: string; body: Record<string, unknown> }
    try {
      upstream = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${shim.token()}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(attempt.body),
        signal: controller.signal,
      })
    } catch (error) {
      if (!aborted) writeClientError(res, 502, `shim unreachable: ${errorMessage(error)}`)
      return
    }

    if (upstream.ok && upstream.body !== null) {
      if (index > 0) log(`messages ${mapped.model}: recovered with ${attempt.name}`)
      break
    }

    const text = await upstream.text().catch(() => '')
    const channelBlocked = upstream.status === 400 && text.includes('11128')
    if (channelBlocked && index < attempts.length - 1) {
      log(`messages ${mapped.model}: upstream 11128 on ${attempt.name}; retrying as ${(attempts[index + 1] as { name: string }).name}`)
      continue
    }
    failureText = text
    break
  }

  if (upstream === undefined) {
    if (!aborted) writeClientError(res, 502, 'no upstream response')
    return
  }

  if (!upstream.ok || upstream.body === null) {
    let message = failureText
    try {
      const parsed: unknown = JSON.parse(failureText)
      if (typeof parsed === 'object' && parsed !== null) {
        const inner = (parsed as Record<string, unknown>)['error']
        if (typeof inner === 'object' && inner !== null) {
          const innerMessage = (inner as Record<string, unknown>)['message']
          if (typeof innerMessage === 'string') message = innerMessage
        } else {
          const msg = (parsed as Record<string, unknown>)['msg']
          if (typeof msg === 'string') message = msg
        }
      }
    } catch {
      // Keep the raw text.
    }

    if (failureText.includes('11128')) {
      try {
        const { writeFileSync } = await import('node:fs')
        const systemMessage = (mapped.messages as Record<string, unknown>[]).find(item => item['role'] === 'system')
        writeFileSync(new URL('./bridge-last-failure.json', import.meta.url), JSON.stringify({
          status: upstream.status,
          model: mapped.model,
          system: systemMessage?.['content'],
          toolNames: (mapped.tools as Record<string, unknown>[] | undefined)?.map(tool => {
            const fn = tool['function']
            return typeof fn === 'object' && fn !== null ? (fn as Record<string, unknown>)['name'] : undefined
          }),
          messageCount: mapped.messages.length,
          chars: JSON.stringify(mapped).length,
        }, null, 2))
        log('wrote bridge-last-failure.json for diagnostics')
      } catch (error) {
        log(`[warn] could not write failure diagnostics: ${errorMessage(error)}`)
      }
    }

    log(`messages ${mapped.model} -> upstream ${upstream.status} (${Date.now() - startedAt}ms)`)
    writeClientError(res, upstream.status, message.slice(0, 4000))
    return
  }

  const collected: { event: string; data: any }[] = []
  const pending: string[] = []
  let writeChain: Promise<void> = Promise.resolve()

  function format(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  }

  async function pump(): Promise<void> {
    while (pending.length > 0) {
      const chunk = pending.shift() as string
      if (res.writableEnded || res.destroyed) return
      if (!res.write(chunk)) {
        try {
          await once(res, 'drain')
        } catch {
          return
        }
      }
    }
  }

  function flush(): Promise<void> {
    writeChain = writeChain.then(pump, pump)
    return writeChain
  }

  const emit = (event: string, data: unknown): void => {
    if (wantsStream) pending.push(format(event, data))
    else collected.push({ event, data })
  }

  let ping: NodeJS.Timeout | undefined
  if (wantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'request-id': `req_${randomBytes(8).toString('hex')}`,
      ...CORS_HEADERS,
    })
    ping = setInterval(() => {
      pending.push(`event: ping\ndata: {"type":"ping"}\n\n`)
      void flush()
    }, 15000)
  }

  const translator = new TurnTranslator(emit, mapped.model, inputTokens)
  translator.begin()
  await flush()

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const parse = createSseParser(data => {
    if (data === '[DONE]') return
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    translator.chunk(payload)
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parse(decoder.decode(value, { stream: true }))
      await flush()
    }
    parse(decoder.decode())
    translator.finish()
    await flush()

    if (!wantsStream) {
      writeJson(res, 200, eventsToMessage(collected))
    } else if (!res.writableEnded && !res.destroyed) {
      res.end()
    }
    log(`messages ${mapped.model} stream ok ${Date.now() - startedAt}ms`)
  } catch (error) {
    if (!aborted) {
      const message = `upstream stream failed: ${errorMessage(error)}`
      log(`messages ${mapped.model} failed: ${message}`)
      if (wantsStream) {
        translator.fail(message)
        await flush()
        if (!res.writableEnded && !res.destroyed) res.end()
      } else {
        writeClientError(res, 502, message)
      }
    }
  } finally {
    if (ping !== undefined) clearInterval(ping)
    controller.abort()
  }
}

function handleModels(res: ServerResponse): void {
  const rows = modelRows()
  const data = rows.map(row => ({
    type: 'model',
    id: row.id,
    display_name: row.name,
    created_at: '2026-01-01T00:00:00Z',
  }))
  writeJson(res, 200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  let path = url.pathname

  // The desktop app's gateway profiles append a deployment prefix (CC Switch
  // uses /claude-desktop); accept either form so one bridge serves both.
  if (path === '/claude-desktop') path = '/'
  else if (path.startsWith('/claude-desktop/')) path = path.slice('/claude-desktop'.length)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  if (req.method === 'HEAD' || req.method === 'GET') {
    if (path === '/' || path === '/health' || path === '/healthz' || path === '/v1/health') {
      if (req.method === 'HEAD') {
        res.writeHead(200, CORS_HEADERS)
        res.end()
        return
      }
      writeJson(res, 200, {
        ok: true,
        service: 'xdpool-bridge',
        accounts: pool.list().length,
        models: catalog.current().length,
        model: DEFAULT_MODEL,
        shim: shim.baseUrl(),
      })
      return
    }
  }

  if (!authorized(req)) {
    writeClientError(res, 401, 'missing or invalid credentials')
    return
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
    handleModels(res)
    return
  }

  if (req.method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/')) {
    await handleMessages(req, res)
    return
  }

  if (req.method === 'POST' && (path === '/v1/messages/count_tokens' || path === '/v1/messages/count_tokens/')) {
    try {
      const parsed: unknown = JSON.parse(await readBody(req))
      writeJson(res, 200, { input_tokens: estimateTokens(parsed) })
    } catch (error) {
      writeClientError(res, 400, `invalid request body: ${errorMessage(error)}`)
    }
    return
  }

  writeClientError(res, 404, `unknown route: ${req.method ?? 'GET'} ${path}`)
}

await seed()
const shim = createWorkBuddyShim({ pool, client, catalog, logger })
await shim.ready
log(`shim listening at ${shim.baseUrl()}`)
log(`models: ${catalog.current().map(model => model.id).join(', ')}`)
log(`default model: ${DEFAULT_MODEL}`)

const server = createServer((req, res) => {
  void handle(req, res).catch(error => {
    log(`[error] unhandled: ${errorMessage(error)}`)
    if (!res.headersSent) writeClientError(res, 500, errorMessage(error))
    else if (!res.writableEnded) res.end()
  })
})
server.listen(PORT, HOST, () => {
  log(`ready at http://${HOST}:${PORT} (token: ${TOKEN === 'xdpool-local' ? 'xdpool-local' : 'set via WB_TOKEN'})`)
})

const rescan = setInterval(() => void seed(), RESCAN_MS)
rescan.unref()

async function shutdown(signal: string): Promise<void> {
  log(`stopping (${signal})`)
  clearInterval(rescan)
  server.close()
  await shim.close().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
