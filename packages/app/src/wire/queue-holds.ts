import {
  type InboxRow,
  type IntakeItem,
  intakeFrom,
  intakeOf,
  type PlanChoice,
  type PlanStanding,
  planStandings,
  planTooTight,
  type Queued,
  type StartSays,
  taskOrigin,
} from '@tade/core'
import { inTime } from '@tade/web'
import { intakeStands } from '@tade/workbench'
import type { Wiring } from './context.ts'

// What holds queued work at the moment it would start, beyond what the queue's
// own rule reads: the plan, for work nobody here asked for, and the grant and
// the source, for work from outside. Asked by the queue's pass (`queue.ts`) and
// by an inbox row being approved, so that the two are one answer.

/** How long a sign-in that can be asked for its plan has, before a start is let through to find out. */
export const ASK_PLANS_MS = 10_000

/**
 * The sign-in a start of this task would run as: the harness its route
 * resolves to, or the one its task file names, and the account it runs as
 * there. The workbench's own answer (`agentHarness`), which is the question
 * the start itself asks, so the plan read is the plan spent. Null where it
 * could not say — the start asks again, fails on the same answer, and says why.
 */
export async function spentBy(wire: Wiring, task: string): Promise<PlanChoice | null> {
  const known = await wire.opts.client.agentHarness(task).catch((err: unknown) => {
    wire.note(err)
    return null
  })
  return known ? { harness: known.harness, account: known.account } : null
}

/** What one start would spend, and every sign-in's plan as it stands at that start. */
export interface Spending {
  spends: PlanChoice | null
  plans: readonly PlanStanding[]
}

/**
 * Why queued work a schedule or a watch made does not start now, or null:
 * the plan window of the sign-in it would run as is nearly full and
 * `queue.hold_scheduled` is on (`planTooTight`'s rule, which argues both).
 * Read from the config and the plan standings as they are at this start, like
 * the trees.
 */
export async function planHold(wire: Wiring, item: Queued): Promise<string | null> {
  if (!wire.opts.config.queue.hold_scheduled) return null
  if (taskOrigin(item.by).kind !== 'schedule') return null
  const standings = planStandings(wire.opts.client.planUsage(), wire.now())
  const spends = await spentBy(wire, item.task)
  return planTooTight(standings, spends, 'scheduled', null)?.because ?? null
}

/**
 * Work from outside running now, where any is: what an unknown plan lets one
 * start through at a time for (`planTooTight`'s `probing`). A run still open of
 * a task not finished — one that has finished has said what it will.
 */
export function probingNow(
  wire: Wiring,
  intake: ReadonlyMap<string, IntakeItem>,
  finished: ReadonlyMap<string, unknown>,
): string | null {
  const running = wire.opts.client
    .runs()
    .find((run) => intakeOf(intake, run.task) !== null && !finished.has(run.task))
  return running?.task ?? null
}

/**
 * What a start from outside about to be decided would spend — after asking,
 * first and with a deadline, the sign-in it would run as, where that one can
 * be asked without running anything and the rule would otherwise let the start
 * through to find out. An answer asked for costs nothing and a start costs an
 * agent, so the asked one is preferred; one that did not come in time leaves
 * the plan unknown, and the start goes as the rule says. No other sign-in is
 * asked: the rule reads only this one, so its answer could change nothing.
 */
export async function plansFor(
  wire: Wiring,
  task: string,
  probing: string | null,
): Promise<Spending> {
  const spends = await spentBy(wire, task)
  const sources = wire.opts.client.planUsage()
  const plans = planStandings(sources, wire.now())
  if (!spends || planTooTight(plans, spends, 'outside', probing)?.kind !== 'probe') {
    return { spends, plans }
  }
  // Let through means this sign-in is on a plan nobody can see yet.
  const spent = sources.find(
    (one) => one.harness === spends.harness && one.account === spends.account,
  )
  if (spent?.can !== 'anytime') return { spends, plans }
  const ask = wire.opts.client.askPlans(ASK_PLANS_MS, spends).catch((err: unknown) => {
    wire.note(err)
    return null
  })
  const asked = await inTime(ask, ASK_PLANS_MS + 1_000, null)
  return { spends, plans: planStandings(asked ?? wire.opts.client.planUsage(), wire.now()) }
}

/**
 * Why an intake-originated start does not go ahead now, waits, or why it went —
 * and for anything else, null without asking anybody anything.
 *
 * The rule is `intakeStands`'; what is here is the three things only the
 * window has: the config as it stands, the plan standings it already folds for
 * the strip, and the extension host that can ask a watch about its source.
 * A source whose watch is gone — the extension turned off, the schedule
 * removed — holds, because a request nobody can check is a request nobody has
 * confirmed still stands.
 */
export async function intakeSays(
  wire: Wiring,
  one: IntakeItem | null,
  task: string,
  spending: Spending,
  probing: string | null,
): Promise<StartSays | null> {
  if (!one) return null
  const host = wire.opts.extensions
  const schedule = wire.opts.client.schedules().find((kept) => kept.id === one.schedule)
  const input = schedule?.does.kind === 'watch' ? schedule.does.input : {}
  return intakeStands({
    config: wire.opts.config,
    item: one,
    task,
    plans: spending.plans,
    spends: spending.spends,
    probing,
    recheck: async (key) => {
      if (!host) throw new Error('this window runs no extensions')
      if (!one.watch) throw new Error('nothing says which watch found it')
      return host.recheck(one.watch, { project: one.project, input, key })
    },
  })
}

/**
 * The same question, asked of an inbox row rather than of a start.
 *
 * **Here because the rule has to be one rule.** A paired device asking to
 * approve a request that came from outside gets the grant, the plan and the
 * source asked again — which is what the queue asks at the moment it
 * would start one, and a second reading of it in the away view's own wiring
 * would be a second answer to one question. The window hands this to
 * `webActing` as `stands`.
 *
 * A row Tade has no record of holds: approving a request whose own item is
 * not in the journal is approving something nothing can check. Only a hold
 * refuses it — work that would wait its turn on an unknown plan, or be let
 * through to make one known, is the queue's to start as its rule says — and it
 * is asked as though nothing ran, so that the source is asked too.
 */
export async function standsFor(wire: Wiring, row: InboxRow): Promise<string | null> {
  const events = wire.live?.events ?? (await wire.opts.client.events({}))
  const one = intakeFrom(events).get(row.item) ?? null
  if (!one) {
    return `has no record on this machine that Tade can check: approve it at the machine`
  }
  const task = row.tasks[0] ?? ''
  const spending = {
    spends: await spentBy(wire, task),
    plans: planStandings(wire.opts.client.planUsage(), wire.now()),
  }
  const says = await intakeSays(wire, one, task, spending, null)
  return says?.kind === 'held' ? says.because : null
}
