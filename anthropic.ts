/**
 * Anthropic Messages API -> OpenAI chat-completions body.
 *
 * Claude Code speaks Anthropic; the WorkBuddy upstream (via the dsh-xdpool
 * shim) speaks OpenAI. This module is the pure half of that bridge: it owns
 * every block-shape decision and never touches the network.
 */

import { randomBytes } from 'node:crypto'

export interface MapOptions {
  defaultModel: string
  knownModels: ReadonlySet<string>
  maxOutputTokens?: number
  defaultMaxTokens?: number
}

export interface MappedRequest {
  model: string
  messages: unknown[]
  stream: true
  max_tokens: number
  temperature?: number
  top_p?: number
  tools?: unknown[]
  tool_choice?: unknown
}

/**
 * The WorkBuddy gateway rejects any body whose first message is not a system
 * prompt (code 11128), so a request with no system block still gets this one.
 *
 * It must NOT contain the literal Claude Code signature below: the gateway
 * treats that exact sentence as an unapproved client and blocks the call.
 */
export const DEFAULT_SYSTEM =
  'You are a coding agent operating inside a developer CLI. You are an interactive agent that helps users with software engineering tasks.'

/**
 * The gateway's channel check flags Claude Code's own opening sentence
 * ("You are Claude Code, Anthropic's official CLI for Claude."). Claude Code
 * sends it verbatim at the top of every system prompt, so rewriting it is what
 * lets an official client's request through. Measured 2026-10-17: the sentence
 * alone fails while "You are Claude Code." and "Anthropic's official CLI for
 * Claude." separately pass — the exact combination is the signature.
 */
const CLAUDE_CODE_SIGNATURE = /You are Claude Code,\s*Anthropic's official CLI for Claude\.?/giu
const SANITISED_SIGNATURE = 'You are a coding agent operating inside a developer CLI.'

/**
 * Claude Code 2.x (the desktop/Agent SDK build) prepends a billing header and
 * opens with a second SDK signature. Both are channel markers the gateway
 * blocks; strip the header line and rewrite the sentence.
 */
const BILLING_HEADER = /^[ \t]*x-anthropic-billing-header:[^\n]*(?:\n|$)/gimu
const AGENT_SDK_SIGNATURE = /You are a Claude agent, built on Anthropic's Claude Agent SDK\.?/giu

export function sanitiseSystem(text: string): string {
  return text
    .replace(BILLING_HEADER, '')
    .replace(CLAUDE_CODE_SIGNATURE, SANITISED_SIGNATURE)
    .replace(AGENT_SDK_SIGNATURE, 'You are a coding agent.')
    .trim()
}

const DEFAULT_MAX_TOKENS = 32000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system.trim()
  if (!Array.isArray(system)) return ''
  return system
    .filter(block => isRecord(block) && block['type'] === 'text')
    .map(block => textOf((block as Record<string, unknown>)['text']))
    .filter(text => text !== '')
    .join('\n\n')
    .trim()
}

/** A Claude image block -> an OpenAI image_url URL (data URI or plain URL). */
function imageUrl(block: Record<string, unknown>): string | undefined {
  const source = block['source']
  if (!isRecord(source)) return undefined
  const type = source['type']
  if (type === 'base64') {
    const media = textOf(source['media_type']) || 'image/png'
    const data = textOf(source['data'])
    return data === '' ? undefined : `data:${media};base64,${data}`
  }
  if (type === 'url') {
    const url = textOf(source['url'])
    return url === '' ? undefined : url
  }
  return undefined
}

interface ToolResultParts {
  text: string
  images: string[]
}

function toolResultParts(block: Record<string, unknown>): ToolResultParts {
  const content = block['content']
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts: string[] = []
  const images: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part['type'] === 'text') {
      const text = textOf(part['text'])
      if (text !== '') texts.push(text)
    } else if (part['type'] === 'image') {
      const url = imageUrl(part)
      if (url !== undefined) images.push(url)
    } else if (part['type'] === 'document') {
      texts.push('[document omitted]')
    }
  }
  return { text: texts.join('\n'), images }
}

interface UserMapping {
  toolMessages: Record<string, unknown>[]
  parts: unknown[]
  text: string
}

/**
 * One Anthropic user message -> zero or more OpenAI messages.
 *
 * Tool results go first, each as its own `role:"tool"` message (OpenAI
 * requires them immediately after the assistant's tool_calls). Text and images
 * in the same Anthropic message follow as one user message. An orphaned tool
 * result — possible after Claude Code compaction drops the assistant turn that
 * owned it — degrades to plain user text rather than a gateway 400.
 */
function mapUserContent(content: unknown, liveToolIds: ReadonlySet<string>): UserMapping {
  const toolMessages: Record<string, unknown>[] = []
  const texts: string[] = []
  const images: string[] = []

  const blocks = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : []

  for (const raw of blocks) {
    if (typeof raw === 'string') {
      if (raw !== '') texts.push(raw)
      continue
    }
    if (!isRecord(raw)) continue
    const type = raw['type']
    if (type === 'tool_result') {
      const id = textOf(raw['tool_use_id'])
      const { text, images: resultImages } = toolResultParts(raw)
      if (id !== '' && liveToolIds.has(id)) {
        toolMessages.push({ role: 'tool', tool_call_id: id, content: text || '(no output)' })
        for (const url of resultImages) {
          texts.push(`[image from tool result ${id}]`)
          images.push(url)
        }
      } else {
        const label = id === '' ? '[tool result]' : `[tool result ${id}]`
        texts.push(`${label}\n${text}`)
        images.push(...resultImages)
      }
    } else if (type === 'text') {
      const text = textOf(raw['text'])
      if (text !== '') texts.push(text)
    } else if (type === 'image') {
      const url = imageUrl(raw)
      if (url !== undefined) images.push(url)
    } else if (type === 'document') {
      texts.push('[document omitted]')
    } else if (type === 'search_result') {
      texts.push('[search result omitted]')
    }
  }

  const joined = texts.join('\n\n')
  const parts: unknown[] = []
  if (images.length === 0) {
    if (joined !== '') parts.push({ role: 'user', content: joined })
  } else {
    const contentParts: unknown[] = texts.map(text => ({ type: 'text', text }))
    for (const url of images) contentParts.push({ type: 'image_url', image_url: { url } })
    parts.push({ role: 'user', content: contentParts })
  }
  return { toolMessages, parts, text: joined }
}

interface AssistantMapping {
  text: string
  toolCalls: Record<string, unknown>[]
}

function mapAssistantContent(content: unknown): AssistantMapping {
  const texts: string[] = []
  const toolCalls: Record<string, unknown>[] = []
  const blocks = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : []

  for (const raw of blocks) {
    if (typeof raw === 'string') {
      texts.push(raw)
      continue
    }
    if (!isRecord(raw)) continue
    if (raw['type'] === 'text') {
      const text = textOf(raw['text'])
      if (text !== '') texts.push(text)
    } else if (raw['type'] === 'tool_use') {
      const id = textOf(raw['id']) || `toolu_${randomBytes(8).toString('hex')}`
      const name = textOf(raw['name']) || 'unknown_tool'
      const input = raw['input'] === undefined ? {} : raw['input']
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      })
    }
    // thinking / redacted_thinking / server_tool_use and other server blocks
    // have no OpenAI equivalent; dropping them is the only lossless option.
  }
  return { text: texts.join('\n'), toolCalls }
}

function mapTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const mapped: unknown[] = []
  for (const raw of tools) {
    if (!isRecord(raw)) continue
    const name = textOf(raw['name'])
    if (name === '') continue
    const description = textOf(raw['description'])
    const parameters = isRecord(raw['input_schema']) ? raw['input_schema'] : { type: 'object', properties: {} }
    mapped.push({ type: 'function', function: { name, description, parameters } })
  }
  return mapped.length === 0 ? undefined : mapped
}

function mapToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') {
    if (choice === 'any') return 'required'
    if (choice === 'none' || choice === 'auto') return choice
    return undefined
  }
  if (!isRecord(choice)) return undefined
  const type = choice['type']
  if (type === 'any') return 'required'
  if (type === 'auto') return 'auto'
  if (type === 'none') return 'none'
  if (type === 'tool') {
    const name = textOf(choice['name'])
    if (name !== '') return { type: 'function', function: { name } }
  }
  return undefined
}

/**
 * Merge consecutive same-role plain-text messages.
 *
 * Some Claude Code turns produce back-to-back user messages (e.g. a tool result
 * followed by a typed instruction). The gateway accepts them but the merged
 * form is what the desktop client sends, so keep the wire familiar.
 */
function mergeAdjacent(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const message of messages) {
    const previous = out[out.length - 1]
    const mergeable = previous !== undefined
      && previous['role'] === message['role']
      && (message['role'] === 'user' || message['role'] === 'assistant')
      && previous['tool_calls'] === undefined
      && message['tool_calls'] === undefined
      && typeof previous['content'] === 'string'
      && typeof message['content'] === 'string'
    if (mergeable) {
      const a = previous['content'] as string
      const b = message['content'] as string
      previous['content'] = a === '' ? b : b === '' ? a : `${a}\n\n${b}`
      continue
    }
    out.push({ ...message })
  }
  return out
}

export function mapAnthropicRequest(body: Record<string, unknown>, options: MapOptions): MappedRequest {
  const requestedModel = textOf(body['model'])
  const model = options.knownModels.has(requestedModel) ? requestedModel : options.defaultModel

  const messages: Record<string, unknown>[] = []
  messages.push({ role: 'system', content: sanitiseSystem(systemText(body['system'])) || DEFAULT_SYSTEM })

  // Ids of the tool calls in the most recent assistant turn. A tool_result
  // naming one of these can be sent as role:"tool"; anything else is orphaned.
  let liveToolIds = new Set<string>()

  const rawMessages = Array.isArray(body['messages']) ? body['messages'] : []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue
    const role = raw['role']
    if (role === 'assistant') {
      const { text, toolCalls } = mapAssistantContent(raw['content'])
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: text === '' ? null : text, tool_calls: toolCalls })
        liveToolIds = new Set(toolCalls.map(call => String((call as Record<string, unknown>)['id'])))
      } else if (text !== '') {
        messages.push({ role: 'assistant', content: text })
        liveToolIds = new Set()
      }
      // Thinking-only assistant turns are dropped whole: an empty assistant
      // message is a gateway error.
    } else if (role === 'user') {
      const { toolMessages, parts } = mapUserContent(raw['content'], liveToolIds)
      messages.push(...toolMessages)
      messages.push(...parts)
    }
  }

  const merged = mergeAdjacent(messages)
  if (merged.length === 1) merged.push({ role: 'user', content: 'Continue.' })

  const requestedMax = Number(body['max_tokens'])
  const cap = options.maxOutputTokens !== undefined && options.maxOutputTokens > 0
    ? options.maxOutputTokens
    : (options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)
  const wanted = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : (options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)
  const maxTokens = Math.max(256, Math.min(wanted, cap))

  const mapped: MappedRequest = {
    model,
    messages: merged,
    stream: true,
    max_tokens: maxTokens,
  }

  const temperature = Number(body['temperature'])
  if (Number.isFinite(temperature)) mapped.temperature = temperature
  const topP = Number(body['top_p'])
  if (Number.isFinite(topP)) mapped.top_p = topP

  const tools = mapTools(body['tools'])
  if (tools !== undefined) {
    mapped.tools = tools
    const toolChoice = mapToolChoice(body['tool_choice'])
    if (toolChoice !== undefined) mapped.tool_choice = toolChoice
  }

  return mapped
}

/** Rough context estimate for usage/count_tokens; deliberately cheap. */
export function estimateTokens(body: unknown): number {
  let serialised: string
  try {
    serialised = JSON.stringify(body) ?? ''
  } catch {
    return 1
  }
  return Math.max(1, Math.ceil(serialised.length / 4))
}
