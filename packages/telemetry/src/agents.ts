import type { Reporter, Span } from './port.ts'

// What an agent does, as the work of a model.
//
// Wilco runs agents; the supervisor sees a turn start, the tools it calls, what
// it cost and how it ended. Said in Sentry's own words for agents — a
// `gen_ai.invoke_agent` span per turn, a `gen_ai.execute_tool` span per tool —
// that becomes the same picture Sentry draws for any agent: how long turns
// take, which tools they spend it in, what they cost, and how often they fail.
//
// Only shapes and numbers: what the agent was asked, what it answered and what
// a tool was given are not here, and must not be.

/** How many tools one turn may have open before the rest go untimed. */
const TOOLS_MAX = 100

export interface TurnStart {
  task: string
  /** What it is running on, as the harness last said. */
  model?: string | null
  provider?: string | null
  harness?: string
  at?: number
}

export interface TurnUsage {
  model?: string | null
  input?: number | null
  output?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  tokens?: number | null
  usd?: number | null
}

/** Each agent's turn, while it is in it. */
export interface AgentTurns {
  started(run: string, what: TurnStart): void
  tool(run: string, what: { callId: string; tool: string; at?: number }): void
  toolDone(run: string, what: { callId: string; ok: boolean; at?: number }): void
  usage(run: string, usage: TurnUsage): void
  done(run: string, what: { status: string; reason?: string; at?: number }): void
  /** The agent is gone: whatever was open ends where it stopped. */
  gone(run: string): void
}

interface Turn {
  span: Span
  task: string
  tools: Map<string, Span>
}

export function agentTurns(reporter: Reporter): AgentTurns {
  const turns = new Map<string, Turn>()

  const close = (run: string, how: { status?: string; at?: number }) => {
    const turn = turns.get(run)
    if (!turn) return
    turns.delete(run)
    for (const tool of turn.tools.values()) tool.end(how.at)
    if (how.status && how.status !== 'ok')
      turn.span.about({ 'gen_ai.response.finish_reasons': how.status })
    turn.span.end(how.at)
  }

  return {
    started(run, what) {
      close(run, { at: what.at })
      const span = reporter.doing({
        name: `invoke_agent ${what.task}`,
        op: 'gen_ai.invoke_agent',
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.agent.name': what.task,
          ...(what.model ? { 'gen_ai.request.model': what.model } : {}),
          ...(what.provider ? { 'gen_ai.provider.name': what.provider } : {}),
          ...(what.harness ? { 'wilco.harness': what.harness } : {}),
          'wilco.project': what.task.split('/')[0] ?? what.task,
        },
        ...(what.at ? { startedAt: what.at } : {}),
      })
      turns.set(run, { span, task: what.task, tools: new Map() })
    },
    tool(run, what) {
      const turn = turns.get(run)
      if (!turn || turn.tools.size >= TOOLS_MAX || turn.tools.has(what.callId)) return
      turn.tools.set(
        what.callId,
        turn.span.inside({
          name: `execute_tool ${what.tool}`,
          op: 'gen_ai.execute_tool',
          attributes: { 'gen_ai.tool.name': what.tool, 'gen_ai.operation.name': 'execute_tool' },
          ...(what.at ? { startedAt: what.at } : {}),
        }),
      )
    },
    toolDone(run, what) {
      const turn = turns.get(run)
      const tool = turn?.tools.get(what.callId)
      if (!turn || !tool) return
      turn.tools.delete(what.callId)
      if (!what.ok) tool.about({ 'wilco.ok': false })
      tool.end(what.at)
    },
    usage(run, usage) {
      const turn = turns.get(run)
      if (!turn) return
      const numbers: Record<string, string | number> = {}
      if (usage.model) numbers['gen_ai.response.model'] = usage.model
      if (usage.input) numbers['gen_ai.usage.input_tokens'] = usage.input
      if (usage.output) numbers['gen_ai.usage.output_tokens'] = usage.output
      if (usage.cacheRead) numbers['gen_ai.usage.input_tokens.cached'] = usage.cacheRead
      if (usage.cacheWrite) numbers['gen_ai.usage.input_tokens.cache_write'] = usage.cacheWrite
      if (usage.tokens) numbers['gen_ai.usage.total_tokens'] = usage.tokens
      if (usage.usd) numbers['gen_ai.cost.total_tokens'] = usage.usd
      turn.span.about(numbers)
    },
    done(run, what) {
      close(run, what)
    },
    gone(run) {
      close(run, {})
    },
  }
}
