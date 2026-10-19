/**
 * Outbound wire for the免密 free lane.
 *
 * Every fact encoded here was verified against the live gateway by direct
 * request rather than inferred from its documentation, which matters because
 * each one is a hard gate that answers with a bare error and no explanation:
 *
 * - `Authorization: Bearer public` is the pooled credential. There is no
 *   per-user secret on this lane, so a request that carries a real key is
 *   rejected as unknown.
 * - A User-Agent below 1.17 is refused outright.
 * - The tool-fingerprint quartet must be declared or the turn answers
 *   `403 FreeTierError`. A slot the caller has no tool for is filled by
 *   promoting a tool that can genuinely answer for it — on Windows the harness
 *   names its shell `pwsh`, not `bash` — and only a slot with nothing to promote
 *   gets a self-disabling decoy. The rename map that promotion produces is what
 *   makes the call come back executable.
 * - Quota is accounted PER SESSION. A fresh session id per request exhausts it
 *   and surfaces as a 429 with a growing retry-after, so a downstream
 *   conversation is mapped onto one stable session by digest.
 * - The endpoint is per MODEL, not per request: the same model cannot be asked
 *   through the other wire even if it would accept it.
 *
 * @module src/free-upstream
 */

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import {
  AggregateError,
  classifyUpstream,
  readSseHead,
  retryAfterMs,
  sniffBodyShape,
} from './aggregate.ts'
import {
  FINGERPRINT_TOOLS,
  FreeToolWire,
  chatChunksFor,
  type FreeEvent,
  type FreeWire,
} from './free-messages.ts'

/** Overridable so the offline suite can point the lane at a dead port. */
export const FREE_UPSTREAM_BASE = process.env.XDPOOL_FREE_BASE ?? 'https://opencode.ai'
/** The gateway's User-Agent check refuses anything below 1.17. */
export const FREE_CLIENT_UA = 'opencode/1.18.31'
/** Anthropic's version header, for the Messages wire. */
export const ANTHROPIC_API_VERSION = '2023-06-01'
/** Listing round budget. */
export const FREE_LISTING_TIMEOUT_MS = 15_000
/** One turn's budget, matching the pool shim's idle ceiling. */
export const FREE_TURN_TIMEOUT_MS = 300_000

const MAX_SESSION_LENGTH = 256
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Quartet slots a tool the caller already has can answer for.
 *
 * dsh names its shell tool `pwsh` on Windows and `bash` elsewhere, so the same
 * lane has to fill the `bash` slot from whichever the kernel mounted.
 */
const QUARTET_DONORS: Readonly<Record<string, readonly string[]>> = { bash: ['pwsh'] }

/** Models served by `/responses` instead of `/chat/completions`. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped `/messages` endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function base62From(bytes: Buffer): string {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62] ?? '0'
  return out
}

let lastStamp = 0
let seq = 0

/** A gateway-shaped canonical session id: time-prefixed, monotonic counter. */
export function mintSessionId(timestamp: number = Date.now()): string {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp
    seq = 0
  }
  seq += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq))
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${base62From(crypto.randomBytes(14))}`
}

/** A gateway-shaped request id for one turn. */
export function mintRequestId(timestamp: number = Date.now()): string {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * This is the difference between a free lane that works and one that 429s: quota
 * is per session, so a fresh id per request burns the budget. A digest of the
 * harness session id gives the same conversation the same canonical session
 * across restarts, which is also how the real client behaves.
 */
export function sessionForConversation(sessionId: string | undefined): string {
  const trimmed = text(sessionId).trim()
  if (SESSION_RE.test(trimmed)) return trimmed.slice(0, MAX_SESSION_LENGTH)
  const seed = trimmed === '' ? 'global' : trimmed
  const digest = crypto.createHash('sha256').update(`xdpool-free\0${seed}`, 'utf8').digest()
  return `ses_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
}

/** A stable per-turn request id, so retries of one turn share it. */
export function requestIdFor(sessionId: string, turnSeed: string | undefined): string {
  if (text(turnSeed) === '') return mintRequestId()
  const digest = crypto.createHash('sha256').update(`xdpool-free-req\0${sessionId}\0${turnSeed}`, 'utf8').digest()
  const id = `msg_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
  return REQUEST_RE.test(id) ? id : mintRequestId()
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model: string): string {
  return model.replace(/\([^()]+\)\s*$/u, '').trim()
}

/** `muse-spark` answers on the Responses wire whatever the exact suffix is. */
function isMuseSpark(modelId: string): boolean {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? (clean.split('/').pop() ?? clean) : clean
  return /^muse[-_]?spark(?:$|[-_:.\s])/iu.test(base)
}

/** Does this model need the Responses wire? */
export function isResponsesModel(modelId: string): boolean {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId)
}

/** Does this model need the Anthropic-shaped wire? */
export function isMessagesModel(modelId: string): boolean {
  return MESSAGES_MODELS.has(baseModelId(modelId))
}

/** Which upstream path serves this model. */
export function endpointFor(modelId: string): string {
  if (isResponsesModel(modelId)) return '/zen/v1/responses'
  if (isMessagesModel(modelId)) return '/zen/v1/messages'
  return '/zen/v1/chat/completions'
}

/** Which wire shape that endpoint speaks; drives encoding and parsing. */
export function wireFor(modelId: string): FreeWire {
  const path = endpointFor(modelId)
  if (path === '/zen/v1/responses') return 'responses'
  if (path === '/zen/v1/messages') return 'messages'
  return 'chat'
}

/** The headers the gateway fingerprints a genuine desktop client by. */
export function gatewayHeaders({
  session,
  requestId,
  stream,
  accept,
}: {
  session: string
  requestId: string
  stream: boolean
  accept?: string
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    // The pooled credential. Sending a real key here reads as an unknown one.
    authorization: 'Bearer public',
    'user-agent': FREE_CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': session,
    'x-opencode-request': requestId,
    'x-opencode-project': 'global',
    accept: accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

function toolNameOf(tool: unknown): string {
  if (!isRecord(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim() !== '') return tool.name.trim()
  const fn = tool.function
  if (isRecord(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/** The quartet key a name answers to, or '' when it is not in the quartet. */
function quartetKey(name: string): string {
  const lower = name.trim().toLowerCase()
  return FINGERPRINT_TOOLS.includes(lower) ? lower : ''
}

/** The Chat-shape `{function:{…}}` wrapper, or null for the flat Responses one. */
function functionOf(tool: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(tool.function) ? tool.function : null
}

/**
 * Satisfy the free-tier fingerprint gate on `body.tools`.
 *
 * All four lowercase quartet names must be declared or the turn answers
 * `403 FreeTierError`. Case variants are canonicalised rather than duplicated —
 * the gateway rejects `Bash` alongside `bash` as a duplicate — and the returned
 * map lets the response side restore the caller's spelling, which is what makes a
 * promoted tool callable instead of merely present.
 *
 * @param body - request body, mutated in place
 * @param wire - which upstream shape `body.tools` is spelled in
 * @returns sent spelling to caller spelling
 */
export function applyFingerprint(body: Record<string, unknown>, wire: FreeWire): Map<string, string> {
  const claude = wire === 'messages'
  const map = new Map<string, string>()
  const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : []
  const hadClientTools = tools.length > 0
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []

  for (const tool of tools) {
    const current = toolNameOf(tool)
    const key = quartetKey(current)
    if (key === '') {
      out.push(tool)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    if (current === key) {
      out.push(tool)
      continue
    }
    map.set(key, current)
    const fn = functionOf(tool)
    out.push(fn === null ? { ...tool, name: key } : { ...tool, function: { ...fn, name: key } })
  }

  // A decoy is a name the model WILL call. With only `pwsh` on the session, the
  // `bash` decoy was recorded being invoked 24 times in one run, every one of
  // them an unknown tool. Promoting the real shell into the slot costs the gate
  // nothing — it fingerprints declared names — and the call comes back
  // executable.
  const promoted = new Set<string>()
  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    const donors = QUARTET_DONORS[name] ?? []
    const index = out.findIndex(tool => {
      const original = toolNameOf(tool)
      if (original === '' || quartetKey(original) !== '') return false
      const lower = original.toLowerCase()
      return !promoted.has(lower) && donors.includes(lower)
    })
    if (index === -1) continue
    const tool = out[index]
    const original = toolNameOf(tool)
    if (tool === undefined || original === '') continue
    promoted.add(original.toLowerCase())
    map.set(name, original)
    const fn = functionOf(tool)
    out[index] = fn === null ? { ...tool, name } : { ...tool, function: { ...fn, name } }
    seen.add(name)
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    out.push(claude
      ? { name, description: 'This tool is currently unavailable and must not be used.', input_schema: { type: 'object', properties: {} } }
      : { type: 'function', name, description: 'This tool is currently unavailable and must not be used.', parameters: { type: 'object', properties: {} } })
  }

  body.tools = out
  if (!body.tool_choice) {
    // The Responses wire asks the gateway to pick a tool; the other two have to
    // say plainly that tools are off, because they are handed nothing the caller
    // declared. The refusal is wire-specific: `auto` on the chat wire is an
    // instruction to call something, and the decoy quartet is not that.
    if (wire === 'responses') body.tool_choice = 'auto'
    else if (!hadClientTools) body.tool_choice = claude ? { type: 'none' } : 'none'
  }
  return map
}

/** Restore the caller's tool spelling in a fragment or a final payload. */
export function restoreToolName(name: string, map: Map<string, string>): string {
  if (map.size === 0) return name
  return map.get(name) ?? name
}

/** Test seam: this lane's own transport, so the suite never leaves the process. */
export const freeLane = { fetch: null as unknown }

/**
 * The free lane's transport.
 *
 * `node:http`/`node:https` rather than `globalThis.fetch`, because local proxy
 * plugins work by replacing `globalThis.fetch` and re-serializing the body on the
 * way out — which mangles a JSON body enough to change the turn. The native
 * modules cannot be swapped by another plugin.
 */
export function freeFetch(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string | undefined
    signal?: AbortSignal | undefined
  } = {},
): Promise<Response> {
  const method = init.method ?? 'GET'
  const stub = freeLane.fetch as unknown as { fetch?: (url: string, init: unknown) => Promise<Response> } | null
  if (stub !== null && typeof stub.fetch === 'function') return stub.fetch(url, { method, ...init })
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        headers:
          init.body === undefined
            ? (init.headers ?? {})
            : { ...(init.headers ?? {}), 'content-length': Buffer.byteLength(init.body, 'utf8') },
      },
      response => {
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            headers: response.headers as unknown as Headers,
          }),
        )
      },
    )
    request.on('error', reject)
    const abort = (): void => {
      request.destroy(new Error('The operation was aborted'))
    }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => {
      init.signal?.removeEventListener('abort', abort)
    })
    if (init.body !== undefined) request.write(init.body, 'utf8')
    request.end()
  })
}

/** One turn's outcome: the upstream status, plus what the stream carried. */
export interface FreeTurnResult {
  status: number
  /** Set when the turn ended on the output ceiling rather than a finish token. */
  truncated?: boolean
  /** Every decoy call the model made and the caller cannot run. */
  suppressedOnly?: boolean
  /**
   * The finish token the caller should be told.
   *
   * Computed here rather than taken from the upstream frame, because only this
   * module knows how many calls survived the decoy filter — the gateway reported
   * a call the caller cannot run, and echoing that back would leave the turn
   * claiming `tool_calls` with nothing to run.
   */
  finishReason?: string
}

/** What one turn's caller wants back per decoded event. */
export interface FreeTurnHooks {
  /**
   * One chat-shaped delta, already translated from the upstream wire.
   *
   * The caller owns the response framing, so this is the delta object only — no
   * chunk envelope, no `data:` prefix.
   */
  onDelta: (delta: Record<string, unknown>) => void
}

/**
 * POST one streaming turn and hand back chat-shaped deltas.
 *
 * The shape of the ANSWER decides how it is read, never its Content-Type: a front
 * proxy that mislabels a JSON body as an event stream is common, and believing
 * the header truncates real answers. A JSON answer to a streamed request is
 * folded through the same translation rather than passed on as one opaque
 * document, so the caller sees a delta sequence either way.
 */
export async function postFreeStreamed(
  {
    modelId,
    body,
    session,
    requestId,
    hooks,
    rename,
    signal,
    timeoutMs = FREE_TURN_TIMEOUT_MS,
  }: {
    modelId: string
    body: Record<string, unknown>
    session: string
    requestId: string
    hooks: FreeTurnHooks
    /** Sent spelling to caller spelling, from the fingerprint pass. */
    rename?: Map<string, string> | undefined
    signal?: AbortSignal | undefined
    timeoutMs?: number
  },
): Promise<FreeTurnResult> {
  const wire = wireFor(modelId)
  const bodyText = JSON.stringify({ ...body, model: modelId, stream: true })
  const url = `${FREE_UPSTREAM_BASE}${endpointFor(modelId)}`
  const headers = gatewayHeaders({ session, requestId, stream: true })
  if (wire === 'messages') headers['anthropic-version'] = ANTHROPIC_API_VERSION
  // The rename map is passed IN rather than recomputed here, because the request
  // body was re-spelled by the translation layer before the fingerprint was
  // applied — so this module has no idea which names are the caller's.
  const tools = new FreeToolWire(body.tools, rename)
  let response: Response
  try {
    response = await freeFetch(url, { method: 'POST', headers, body: bodyText, signal })
  } catch (error: unknown) {
    if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
      throw new AggregateError('client', 'request aborted')
    }
    const cause = error instanceof Error ? error.message : String(error)
    throw new AggregateError('server', `the free lane request failed: ${cause}`)
  }
  const retryAfter = retryAfterMs(response)
  if (!response.ok) {
    const refusal = await response.text().catch(() => '')
    throw classifyUpstream(response.status, refusal, retryAfter, '')
  }
  if (response.body === null) throw new AggregateError('server', 'the free lane returned no body', response.status)

  let events: string[]
  let raw = ''
  const head = await readSseHead(response.body, signal ?? new AbortController().signal, timeoutMs)
  if (head.shape === 'sse') {
    events = head.payloads
  } else {
    if (head.shape === 'empty') throw new AggregateError('server', 'the free lane returned no body', response.status)
    raw = head.text
    if (!head.done) {
      try {
        for (;;) {
          const chunk = await head.reader.read()
          if (chunk.done) break
          if (chunk.value !== undefined) raw += head.decoder.decode(chunk.value, { stream: true })
        }
      } catch (error: unknown) {
        await head.reader.cancel().catch(() => null)
        throw new AggregateError('server', `the free lane stream broke: ${error instanceof Error ? error.message : String(error)}`, response.status)
      }
    }
    raw += head.decoder.decode()
    events = jsonAnswerEvents(raw)
  }

  const result: FreeTurnResult = { status: response.status }
  let finish: string | undefined
  let usage: Record<string, unknown> | undefined
  for (const event of events) {
    let decoded: unknown
    try {
      decoded = JSON.parse(event) as unknown
    } catch {
      // A frame the gateway could not write as JSON is not a frame; forwarding it
      // would hand the caller a decoder error instead of an answer.
      continue
    }
    if (isRecord(decoded) && (decoded.error !== undefined || decoded.type === 'error')) {
      throw classifyUpstream(response.status, event, retryAfter, '')
    }
    const translated: FreeEvent = chatChunksFor(wire, decoded, tools)
    for (const delta of translated.frames) hooks.onDelta(delta)
    if (translated.usage !== undefined) usage = translated.usage
    if (translated.finish !== undefined) finish = translated.finish
    if (translated.done === true) result.truncated = finish === 'length'
  }
  // A `tool_calls` finish is only honest when a call survived the decoy filter.
  // Reporting `tool_calls` beside no callable tool — or beside one the caller
  // cannot run — is how a truncated turn comes back demanding a retry forever.
  if (tools.calls() > 0) finish = 'tool_calls'
  else if (finish === 'tool_calls') finish = result.truncated === true ? 'length' : 'stop'
  if (finish === 'length') result.truncated = true
  if (usage !== undefined) hooks.onDelta({ usage })
  result.suppressedOnly = tools.suppressed()
  result.finishReason = finish
  return result
}

/**
 * The events one JSON answer carries.
 *
 * The chat and Messages wires answer with one document; the Responses wire
 * answers with one document too, but its `output` array holds the events that a
 * stream would have delivered. Both are read here so the caller gets one
 * sequence either way.
 */
function jsonAnswerEvents(raw: string): string[] {
  if (sniffBodyShape(raw) === 'sse') {
    // A gateway that answered a stream request with SSE in one write. Keep the
    // frames rather than re-parsing them as JSON.
    return raw
      .split(/\r?\n/u)
      .map(line => line.trimEnd())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .filter(payload => payload !== '' && payload !== '[DONE]')
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw) as unknown
  } catch {
    // A 200 that is not JSON is a hop speaking for the gateway: markup means a
    // front proxy swallowed the answer, and an identical retry draws the same
    // page again, so this must NOT land in a retryable server class.
    if (/^\s*<(!doctype|html[\s>])/iu.test(raw)) {
      throw new AggregateError('client', "the free lane's front proxy answered with an HTML error page")
    }
    throw new AggregateError('server', `unexpected non-stream response: ${raw.slice(0, 200)}`)
  }
  if (isRecord(payload) && payload.type === 'response' && isRecord(payload.response)) {
    // The Responses wire's non-streaming document: replay its own items as the
    // events a stream would have sent, so the translation above sees one shape.
    const events: string[] = []
    const response = payload.response
    const output = isRecord(response) && Array.isArray(response.output) ? response.output : []
    for (const item of output) {
      if (!isRecord(item)) continue
      const kind = text(item.type)
      if (kind === 'function_call') {
        events.push(JSON.stringify({
          type: 'response.output_item.added',
          output_index: events.length,
          item: { type: 'function_call', call_id: text(item.call_id ?? item.id), name: text(item.name) },
        }))
        events.push(JSON.stringify({
          type: 'response.function_call_arguments.delta',
          output_index: events.length,
          delta: text(item.arguments),
        }))
        continue
      }
      // `content` is checked as an array directly rather than through `isRecord`,
      // which is false for arrays — asking it first dropped every message the
      // document carried, leaving a completed response with nothing in it.
      const body = Array.isArray(item.content)
        ? item.content.map(part => (isRecord(part) ? text(part.text) : '')).join('')
        : ''
      if (body === '') continue
      events.push(JSON.stringify({ type: 'response.output_text.delta', output_index: events.length, delta: body }))
    }
    events.push(JSON.stringify({
      type: 'response.completed',
      response: isRecord(response) ? response : {},
    }))
    return events
  }
  return [raw]
}
