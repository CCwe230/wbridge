/**
 * OpenAI chat-completion SSE -> Anthropic Messages SSE.
 *
 * The shim always streams; this turns each OpenAI chunk into the event
 * sequence the Anthropic SDK (and therefore Claude Code) dispatches on.
 */

import { randomBytes } from 'node:crypto'

export type Emit = (event: string, data: unknown) => void

/**
 * Incremental server-sent-events parser.
 *
 * Handles CRLF, multi-line `data:` fields and comments. UTF-8 decoding is the
 * caller's job (feed it strings from a streaming TextDecoder) so a multi-byte
 * character split across chunks cannot corrupt the payload.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (boundary === null) break
      const raw = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      if (raw === '') continue
      const dataLines: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      if (dataLines.length > 0) onData(dataLines.join('\n'))
    }
  }
}

interface ToolCallState {
  id: string
  name: string
  /** Every argument fragment seen, started or not. */
  args: string
  /** Fragments seen before the block could be opened (name not yet known). */
  pending: string
  started: boolean
  blockIndex: number
}

function stopReasonOf(finishReason: string | null, hasTools: boolean): string {
  if (hasTools) return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  return 'end_turn'
}

export class TurnTranslator {
  private readonly id = `msg_${randomBytes(12).toString('hex')}`
  private readonly calls = new Map<number, ToolCallState>()
  private readonly open = new Set<number>()
  private nextIndex = 0
  private textIndex: number | null = null
  private text = ''
  private finishReason: string | null = null
  private inputTokens: number
  private outputTokens: number | null = null

  constructor(
    private readonly emit: Emit,
    private readonly model: string,
    inputTokens: number,
  ) {
    this.inputTokens = inputTokens
  }

  begin(): void {
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    })
  }

  chunk(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return
    const record = payload as Record<string, unknown>

    const usage = record['usage']
    if (typeof usage === 'object' && usage !== null) {
      const u = usage as Record<string, unknown>
      if (typeof u['prompt_tokens'] === 'number' && u['prompt_tokens'] > 0) this.inputTokens = u['prompt_tokens']
      if (typeof u['completion_tokens'] === 'number' && u['completion_tokens'] >= 0) this.outputTokens = u['completion_tokens']
    }

    const choices = record['choices']
    if (!Array.isArray(choices) || choices.length === 0) return
    const choice = choices[0]
    if (typeof choice !== 'object' || choice === null) return
    const c = choice as Record<string, unknown>

    if (typeof c['finish_reason'] === 'string' && c['finish_reason'] !== '') {
      this.finishReason = c['finish_reason']
    }

    const delta = c['delta']
    if (typeof delta !== 'object' || delta === null) return
    const d = delta as Record<string, unknown>

    if (typeof d['content'] === 'string' && d['content'] !== '') this.textDelta(d['content'])
    if (Array.isArray(d['tool_calls'])) {
      for (const toolCall of d['tool_calls']) {
        if (typeof toolCall === 'object' && toolCall !== null) this.toolDelta(toolCall as Record<string, unknown>)
      }
    }
    // reasoning_content is intentionally dropped in this version.
  }

  finish(): void {
    this.closeText()

    for (const call of this.calls.values()) {
      if (!call.started) this.startCall(call)
    }

    if (this.nextIndex === 0) {
      const index = this.nextIndex++
      this.open.add(index)
      this.emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    }

    for (const call of this.calls.values()) {
      if (call.args === '' && call.blockIndex >= 0) {
        this.emit('content_block_delta', {
          type: 'content_block_delta',
          index: call.blockIndex,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        })
      }
    }

    for (const index of [...this.open].sort((a, b) => a - b)) this.closeBlock(index)

    const outputTokens = this.outputTokens ?? Math.max(
      1,
      Math.ceil((this.text.length + [...this.calls.values()].reduce((sum, call) => sum + call.args.length, 0)) / 4),
    )

    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReasonOf(this.finishReason, this.calls.size > 0), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    this.emit('message_stop', { type: 'message_stop' })
  }

  fail(message: string, type = 'api_error'): void {
    this.emit('error', { type: 'error', error: { type, message } })
  }

  private textDelta(text: string): void {
    if (this.textIndex === null) {
      const index = this.nextIndex++
      this.textIndex = index
      this.open.add(index)
      this.emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    }
    this.text += text
    this.emit('content_block_delta', {
      type: 'content_block_delta',
      index: this.textIndex,
      delta: { type: 'text_delta', text },
    })
  }

  private toolDelta(raw: Record<string, unknown>): void {
    // A tool block cannot share an index with an open text block.
    this.closeText()

    const key = typeof raw['index'] === 'number' ? raw['index'] : 0
    let call = this.calls.get(key)
    if (call === undefined) {
      call = {
        id: typeof raw['id'] === 'string' && raw['id'] !== ''
          ? raw['id']
          : `toolu_${randomBytes(8).toString('hex')}`,
        name: '',
        args: '',
        pending: '',
        started: false,
        blockIndex: -1,
      }
      this.calls.set(key, call)
    } else if (typeof raw['id'] === 'string' && raw['id'] !== '') {
      call.id = raw['id']
    }

    const fn = raw['function']
    if (typeof fn === 'object' && fn !== null) {
      const f = fn as Record<string, unknown>
      if (typeof f['name'] === 'string' && f['name'] !== '' && call.name === '') {
        call.name = f['name']
      }
      if (typeof f['arguments'] === 'string' && f['arguments'] !== '') {
        call.args += f['arguments']
        if (call.started) {
          this.emit('content_block_delta', {
            type: 'content_block_delta',
            index: call.blockIndex,
            delta: { type: 'input_json_delta', partial_json: f['arguments'] },
          })
        } else {
          call.pending += f['arguments']
        }
      }
    }

    if (!call.started && call.name !== '') this.startCall(call)
  }

  /**
   * Open the tool_use block. Called lazily because the first fragment normally
   * carries id + name, but nothing guarantees it; opening a block with an empty
   * name would lock in a name the client cannot match to a tool.
   */
  private startCall(call: ToolCallState): void {
    if (call.started) return
    if (call.name === '') call.name = 'unknown_tool'
    call.started = true
    call.blockIndex = this.nextIndex++
    this.open.add(call.blockIndex)
    this.emit('content_block_start', {
      type: 'content_block_start',
      index: call.blockIndex,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    })
    if (call.pending !== '') {
      this.emit('content_block_delta', {
        type: 'content_block_delta',
        index: call.blockIndex,
        delta: { type: 'input_json_delta', partial_json: call.pending },
      })
      call.pending = ''
    }
  }

  private closeText(): void {
    if (this.textIndex !== null) {
      this.closeBlock(this.textIndex)
      this.textIndex = null
    }
  }

  private closeBlock(index: number): void {
    if (!this.open.delete(index)) return
    this.emit('content_block_stop', { type: 'content_block_stop', index })
  }
}
