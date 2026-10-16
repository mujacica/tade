import type { Readable, Writable } from 'node:stream'

// JSON-RPC 2.0 over one message per line, both ways at once: what ACP is
// carried in. Either side may ask the other something, so this is a peer
// rather than a client — Tade asks the agent to prompt, and the agent asks
// Tade whether it may run a command while that prompt is still unanswered.
//
// A line that is not JSON-RPC is reported and skipped, never thrown over: an
// agent that prints a banner on its standard output has said nothing to us.

export interface RpcError extends Error {
  code: number
  data?: unknown
}

export function rpcError(code: number, message: string, data?: unknown): RpcError {
  const err = new Error(message) as RpcError
  err.code = code
  if (data !== undefined) err.data = data
  return err
}

export interface PeerOptions {
  input: Readable
  output: Writable
  /** A request the other side made: its answer, or a throw that becomes its error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>
  onNotification: (method: string, params: unknown) => void
  /** A line that was not a message. Reported, never thrown. */
  onWarning?: (message: string) => void
}

export class Peer {
  private next = 1
  private buffer = ''
  private closed = false
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }
  >()

  private readonly opts: PeerOptions

  constructor(opts: PeerOptions) {
    this.opts = opts
    opts.input.on('data', (chunk: Buffer | string) => this.read(chunk.toString()))
    opts.input.on('end', () => this.close('the agent closed its output'))
    opts.input.on('error', (err: Error) => this.close(`the agent's output failed: ${err.message}`))
  }

  /** Ask the other side something, and wait for its answer. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error(`the agent is gone, so ${method} was not sent`))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Tell the other side something that has no answer. */
  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  /** Every question still waiting is answered with why it never will be. */
  close(why: string): void {
    if (this.closed) return
    this.closed = true
    for (const [, waiting] of this.pending) waiting.reject(new Error(why))
    this.pending.clear()
  }

  private write(message: unknown): void {
    try {
      this.opts.output.write(`${JSON.stringify(message)}\n`)
    } catch (err) {
      this.close(`could not write to the agent: ${(err as Error).message}`)
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let end = this.buffer.indexOf('\n')
    while (end >= 0) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (line) this.receive(line)
      end = this.buffer.indexOf('\n')
    }
  }

  private receive(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
      message = parsed as Record<string, unknown>
    } catch {
      this.opts.onWarning?.(`the agent wrote a line that is not JSON-RPC: ${line.slice(0, 120)}`)
      return
    }
    const { id, method } = message
    if (typeof method === 'string') {
      if (id === undefined || id === null) {
        this.opts.onNotification(method, message.params)
        return
      }
      void this.answer(id, method, message.params)
      return
    }
    if (typeof id !== 'number') return
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined
    if (error && typeof error === 'object') {
      waiting.reject(
        rpcError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' && error.message
            ? error.message
            : `${waiting.method} failed`,
          error.data,
        ),
      )
    } else waiting.resolve(message.result ?? null)
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.opts.onRequest(method, params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const code = typeof (err as RpcError).code === 'number' ? (err as RpcError).code : -32603
      this.write({ jsonrpc: '2.0', id, error: { code, message: (err as Error).message } })
    }
  }
}
