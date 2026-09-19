import type { ChecksConfig, Config } from './config.ts'
import type { TadeEvent } from './events.ts'

// When a project's checks run on their own, and who may overrule that.
//
// Pure, like the state machine: what Tade does before a push is a function of
// the config and of what somebody wrote down, never of anything remembered.
// An override is read back out of the journal rather than held anywhere, so
// closing the window does not lose one and a crash mid-push does not either.

/** How a project checks itself: the global rule, with the project's own answer over it. */
export function checksFor(config: Config, project: string | null): ChecksConfig {
  const own = (project ? config.projects[project]?.checks : undefined) ?? {}
  return { ...config.checks, ...own }
}

/** The tool that writes one down: the journal line it makes is the record. */
export const OVERRIDE_TOOL = 'checks_override'

/** What an override may cover. An agent may only ever ask for its own task. */
export type OverrideScope = 'next push' | 'this task' | 'this project'

export interface Override {
  /** The task it covers, when it covers one. */
  task: string | null
  project: string | null
  scope: OverrideScope
  /** Why, in the words of whoever asked. Never paraphrased. */
  reason: string
  /** Who asked: `orchestrator`, `agent:<task>`, `you`. */
  by: string
  at: number
  /** When it stops applying; null for `next push`, which stops when one happens. */
  until: number | null
}

/** The longest an override may last: after that, somebody asks again. */
export const OVERRIDE_LIMIT_MS = 4 * 3_600_000

/**
 * Why this override may not be asked for, or null. An agent may overrule the
 * rule for its own work and nobody else's: another task's, a whole project's,
 * or a night of them is a person's decision, and the orchestrator's at most.
 */
export function overrideProblem(request: {
  by: 'orchestrator' | 'agent' | 'you'
  askedFor: string
  scope: string
  task: string | null
  reason: string
  forMs?: number | undefined
}): string | null {
  if (!request.reason.trim()) return 'say why: an override nobody hears about is a broken gate'
  const scopes: string[] = ['next push', 'this task', 'this project']
  if (!scopes.includes(request.scope)) {
    return `scope should be one of ${scopes.join(', ')}`
  }
  if ((request.forMs ?? 0) > OVERRIDE_LIMIT_MS) {
    return 'an override may last four hours at the most; ask again after that'
  }
  if (request.by === 'agent') {
    if (request.scope === 'this project')
      return 'an agent may only overrule the rule for its own task'
    if (request.task && request.askedFor && request.askedFor !== request.task) {
      return `this is ${request.task}: it may not overrule the rule for ${request.askedFor}`
    }
  }
  return null
}

/**
 * The overrides written down, newest last. Read from `tool_call` lines, which
 * is where an act with a reason and a who already lives — no new event type,
 * and `tade_check_override` is answerable long after the window closed.
 */
export function overridesFrom(events: readonly TadeEvent[]): Override[] {
  const out: Override[] = []
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    if (event.detail.tool !== OVERRIDE_TOOL) continue
    // Tade's own tools are journalled with what they were called with, so an
    // override is read back out of the same line that records the act.
    const input = event.detail.input
    const detail = {
      ...(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}),
      ...(event.detail as Record<string, unknown>),
      ...(typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}),
    }
    const scope = String(detail.scope ?? '')
    if (scope !== 'next push' && scope !== 'this task' && scope !== 'this project') continue
    const at = Date.parse(event.ts)
    const hours = typeof detail.hours === 'number' ? detail.hours : 0
    const forMs =
      typeof detail.for_ms === 'number'
        ? detail.for_ms
        : hours > 0
          ? Math.min(hours, OVERRIDE_LIMIT_MS / 3_600_000) * 3_600_000
          : null
    out.push({
      task: typeof detail.task === 'string' ? detail.task : event.task,
      project: typeof detail.project === 'string' ? detail.project : null,
      scope,
      reason: String(detail.reason ?? ''),
      by: String(
        detail.by ??
          (detail.caller === 'agent' ? `agent:${event.task ?? ''}` : (detail.caller ?? 'you')),
      ),
      at: Number.isFinite(at) ? at : 0,
      until: forMs === null ? null : (Number.isFinite(at) ? at : 0) + forMs,
    })
  }
  return out
}

/**
 * The override that lets this push through, or null. The newest one that
 * covers it wins, as the last line written always does; a `next push` is
 * spent by the first push after it, which is why what has happened since is
 * part of the question.
 */
export function overrideFor(
  events: readonly TadeEvent[],
  at: { task: string | null; project: string | null; now: number },
): Override | null {
  const overrides = overridesFrom(events)
  for (const override of [...overrides].reverse()) {
    if (override.until !== null && override.until < at.now) continue
    if (override.scope === 'this project') {
      if (override.project && override.project === at.project) return override
      continue
    }
    if (override.task && override.task !== at.task) continue
    if (override.scope === 'this task') return override
    // `next push`: spent once something was pushed after it was written.
    const pushedSince = events.some(
      (event) =>
        Date.parse(event.ts) > override.at &&
        event.type === 'tool_call' &&
        typeof event.detail.command === 'string' &&
        /\bgit\s+push\b/.test(event.detail.command),
    )
    if (!pushedSince) return override
  }
  return null
}

/** Whether the rule says Tade runs the checks itself before this. */
export function runsBefore(checks: ChecksConfig, what: 'commit' | 'push'): boolean {
  if (checks.before === 'off') return false
  if (checks.before === 'commit and push') return true
  return checks.before === what
}

/**
 * What an agent is told about a project's checks: the rule in its own terms,
 * and that Tade runs them one at a time so four agents do not start four
 * suites in one checkout.
 */
export function checksTold(
  checks: ChecksConfig | null,
  ids: readonly string[],
  hold: boolean,
): string | null {
  if (!checks || ids.length === 0) return null
  const when =
    checks.before === 'off'
      ? 'before you push'
      : checks.before === 'commit and push'
        ? 'before you commit and before you push'
        : `before you ${checks.before}`
  const said = [
    `This project's checks are ${ids.map((id) => `\`${id}\``).join(', ')}. Run them with checks_run ${when} — not in a shell: Tade runs them one at a time, so several agents in one checkout do not start several suites, and what ran is shown to the person.`,
    'A red check is something to fix, not something to mention.',
  ]
  said.push(
    hold
      ? 'If you are certain a failure is not yours, call checks_override with the reason and push; the person is told what you said.'
      : 'If you push with something red, call checks_override first with the reason: it is written down, and the person is told what you said.',
  )
  return said.join(' ')
}
