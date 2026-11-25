import type { WorkerSpec } from '@tade/harnesses-core'
import { COMPAT_OFF } from './home.ts'
import { toolOf } from './record.ts'

// Grok run headless, as the thing you talk to: a process per turn.
//
// `grok -p` takes one prompt, works it to the end and exits, printing what
// happened as it goes (`--output-format streaming-json`); the session is what
// makes it one conversation, so each turn starts with `-s <uuid>` the first
// time and `-r <uuid>` after. There is no input stream to steer a turn in
// flight, the reply's text arrives as it streams (`text`), and what each model
// call used comes as it is made (`usage`) and again for the turn at `end`.

/** The line one headless turn is started with. The prompt is said here, once. */
export function headlessArgs(opts: {
  prompt: string
  session: string
  going: boolean
  model: string | null
  effort: string | null
  rules: string | null
  extra: readonly string[]
}): string[] {
  return [
    '-p',
    opts.prompt,
    opts.going ? '-r' : '-s',
    opts.session,
    '--output-format',
    'streaming-json',
    // Nothing of the thing you talk to is gated: it is Tade's own interface.
    '--permission-mode',
    'bypassPermissions',
    '--no-auto-update',
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
    ...(opts.rules ? ['--rules', opts.rules] : []),
    ...opts.extra,
  ]
}

/**
 * What a headless turn runs in: the account's environment, the run's own over
 * it, with nothing of supervision in it — the account folder's hooks and tool
 * server are Tade's, and they stand down where there is no run socket, which
 * is what a turn nobody gates is — and the orchestrator's tools named for the
 * tool server to become (`TADE_GROK_MCP`, `mcp.ts`).
 */
export function headlessEnv(
  account: NodeJS.ProcessEnv,
  spec: WorkerSpec,
  tools: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...account, ...spec.env, ...COMPAT_OFF }
  delete env.TADE_RUN_SOCKET
  delete env.TADE_APPROVALS
  if (tools) env.TADE_GROK_MCP = tools
  else delete env.TADE_GROK_MCP
  return env
}

/** One line of a headless turn's output, as what Tade says about it. */
export type HeadlessEvent =
  | { kind: 'text'; text: string }
  | { kind: 'call'; callId: string; tool: string; input: unknown }
  | { kind: 'result'; callId: string; ok: boolean; summary: string }
  | { kind: 'used'; prompt: number }
  | {
      kind: 'end'
      stop: string
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
      usd: number
      model: string | null
    }
  | { kind: 'error'; message: string }

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** The words of what a tool answered, as a headless line carries them. */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(wordsOf).join('\n')
  if (typeof content !== 'object' || content === null) return ''
  const { text, content: inner } = content as Record<string, unknown>
  if (typeof text === 'string') return text
  return inner === undefined ? '' : wordsOf(inner)
}

/** A line of `--output-format streaming-json`, read; null for anything that is not one of ours. */
export function headlessEvent(line: string): HeadlessEvent | null {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null) return null
  switch (event.type) {
    case 'text':
      return typeof event.data === 'string' && event.data
        ? { kind: 'text', text: event.data }
        : null
    case 'tool_call': {
      if (typeof event.toolCallId !== 'string') return null
      const name =
        typeof event.toolName === 'string'
          ? event.toolName
          : typeof event.title === 'string'
            ? event.title
            : 'tool'
      const call = toolOf(name, event.rawInput ?? {})
      return { kind: 'call', callId: event.toolCallId, tool: call.tool, input: call.input }
    }
    case 'tool_call_update': {
      const status = event.status
      if (typeof event.toolCallId !== 'string') return null
      if (status !== 'completed' && status !== 'failed') return null
      const ok = status === 'completed'
      return {
        kind: 'result',
        callId: event.toolCallId,
        ok,
        summary: ok ? '' : wordsOf(event.content).slice(0, 300),
      }
    }
    case 'usage': {
      const usage = (event.usage ?? {}) as Record<string, unknown>
      return {
        kind: 'used',
        prompt:
          number(usage.input_tokens) +
          number(usage.cache_read_input_tokens) +
          number(usage.cache_creation_input_tokens),
      }
    }
    case 'end': {
      const usage = (event.usage ?? {}) as Record<string, unknown>
      const models = (event.modelUsage ?? {}) as Record<string, Record<string, unknown>>
      const named = Object.keys(models).at(-1) ?? null
      const priced = Object.values(models).reduce((sum, one) => sum + number(one.costUSD), 0)
      const output = number(usage.output_tokens)
      const input = number(usage.input_tokens)
      const cacheRead = number(usage.cache_read_input_tokens)
      const cacheWrite = number(usage.cache_creation_input_tokens)
      // Reasoning is billed as output; counted once, whether or not Grok's
      // `output_tokens` already holds it (`turnSpend` reads the same way).
      const total = number(usage.total_tokens)
      return {
        kind: 'end',
        stop: typeof event.stopReason === 'string' ? event.stopReason : 'unknown',
        usage: {
          input,
          output: Math.max(output, total - input - cacheRead - cacheWrite),
          cacheRead,
          cacheWrite,
        },
        usd: number(event.total_cost_usd) || priced,
        model: named,
      }
    }
    case 'error':
      return { kind: 'error', message: String(event.message ?? 'Grok said there was an error') }
    default:
      return null
  }
}

/** Why a headless turn ended without an answer, from what it wrote before it did. */
export function exitReason(code: number | null, stderr: string): string {
  const said = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return said || `Grok exited with code ${code ?? 'unknown'}`
}
