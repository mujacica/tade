import { DONE_RULES, type DoneRule, When } from '@tade/core'
import type { ToolHostOptions } from './tool-host.ts'

// The `ToolHost` methods behind `tade_schedule` and `tade_proposal_decide`
// (`tools-queue.ts`): work on a clock, and what is decided about the work a
// schedule or a watch made and put to the orchestrator rather than starting.
//
// Its own file because `tool-host.ts` is at its budget. Both are answered by
// the window's queue, which is where a schedule is set and a decision is
// carried out (`wire/schedules.ts`, `wire/proposals.ts`); what is here is
// reading what the model sent carefully, and saying what is malformed.

type Handler = (params: Record<string, unknown>) => Promise<string>
type Queue = NonNullable<ToolHostOptions['queue']>

export function scheduleMethods(queue: () => Queue): Record<string, Handler> {
  return {
    'queue/schedule': async (p) => {
      // A watch looks as often as it says it should unless told otherwise: an
      // empty rule is no rule, not one that can never be kept.
      const unsaid =
        p.when === undefined ||
        p.when === null ||
        (typeof p.when === 'object' && Object.keys(p.when).length === 0)
      const when = unsaid ? null : When.safeParse(p.when)
      if (when && !when.success) {
        throw new Error(
          `when is not a rule: ${when.error.issues.map((issue) => issue.message).join('; ')}`,
        )
      }
      const text = (value: unknown) => (typeof value === 'string' ? value : '')
      const missed = p.missed === 'skip' ? 'skip' : p.missed === 'once' ? 'once' : undefined
      const found = p.found === 'ask' ? 'ask' : p.found === 'agent' ? 'agent' : undefined
      const decides = p.decides === 'itself' || p.decides === 'orchestrator' ? p.decides : null
      if (p.input !== undefined && (typeof p.input !== 'object' || p.input === null)) {
        throw new Error('input is what the watch is turned on with: an object')
      }
      return queue().schedule({
        name: text(p.name),
        project: text(p.project),
        said: text(p.said),
        ...(when?.success ? { when: when.data } : {}),
        ...(p.agent !== undefined ? { agent: text(p.agent) } : {}),
        ...(p.ask !== undefined ? { ask: text(p.ask) } : {}),
        ...(p.watch !== undefined ? { watch: text(p.watch) } : {}),
        ...(p.input !== undefined ? { input: p.input as Record<string, unknown> } : {}),
        ...(found ? { found } : {}),
        ...(typeof p.most === 'number' ? { most: p.most } : {}),
        ...(decides ? { decides } : {}),
        ...(p.done ? { done: doneRuleOf(p.done) } : {}),
        ...(missed ? { missed } : {}),
      })
    },
    // Carried out in the window, through the queue's own doors (`proposals.ts`).
    'queue/decide': async (p) =>
      queue().decide({
        task: String(p.task ?? ''),
        decision: String(p.decision ?? ''),
        because: String(p.because ?? ''),
        ...(typeof p.on === 'string' ? { on: p.on } : {}),
        ...(typeof p.message === 'string' ? { message: p.message } : {}),
      }),
  }
}

/** A rule for finishing, as asked: one there is, or the reason it is not. */
export function doneRuleOf(value: unknown): DoneRule {
  const rule = DONE_RULES.find((one) => one === String(value).trim().toLowerCase())
  if (!rule) throw new Error(`${String(value)} is not a way to finish: ${DONE_RULES.join(', ')}`)
  return rule
}
