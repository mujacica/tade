import { nextPlan, onPlanOf, planStandings, pricesFrom } from '@tade/core'
import type { Frame } from '../frame.ts'
import { projects } from '../model.ts'
import { spendPanel } from '../panels/spend/state.ts'
import { spendView } from '../spend.ts'
import type { Actions, Subject, Wiring } from './context.ts'

// What the agents cost, and what a subscription has used up.
//
// The two are never added together. Where a plan pays for the work there is no
// price per turn, so what is used up is a share of a rolling window, and it
// lives in its own list rather than in a total that would then mean nothing.
// Every figure here is what the *service* told the harness; nothing is counted
// by Tade.
//
// All of it is a fold over the journal, read on the window's beat — so nothing
// here asks anybody anything, and `planUsage` reads what each harness already
// holds rather than reaching for the network four times a second.

/**
 * How long a folded page may be re-read before it is folded again.
 *
 * The page can be asked for the whole journal now, and `facts()` is read four
 * times a second: forty-six thousand usage events folded on every frame to
 * redraw a figure in minutes is the cost of a page nobody could otherwise ask
 * the question on. So the fold is kept, and re-done when what went into it
 * changed — a new event, another range, another grouping — or when a second
 * has gone by, which is what a running clock needs and no more.
 */
const REFOLD_MS = 1_000

export class Spend implements Subject {
  private readonly wire: Wiring
  /** The last page folded: what it was of, when, and the answer. */
  private folded: { key: string; at: number; view: NonNullable<Frame['spendView']> } | null = null

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /** Today's spend and today's runtime, how full each plan's window is, and the page. */
  facts(): Partial<Frame> {
    const live = this.wire.live
    const spent = live?.spendToday()
    return {
      spendView: this.page(),
      spend: {
        tokens: spent?.total.tokens ?? 0,
        usd: spent?.total.usd ?? 0,
        hasCost: spent?.total.hasCost ?? false,
        // What today's plan turns would have cost at list price, which is the
        // only dollar figure a subscription's day has — and never money, so it
        // is its own field and goes nowhere near `usd`.
        usdOnPlan: spent?.total.usdOnPlan ?? 0,
        onPlan: spent ? onPlanOf(spent.total) : 'none',
        byTask: spent?.byTask ?? {},
        ...(live ? { runtime: live.runtimeToday().total } : {}),
      },
      plan: planStandings(this.wire.opts.client.planUsage(), this.wire.now()),
    }
  }

  /**
   * The Spend page, as it is being asked: over which range, split by what.
   *
   * Folded at most once a second, and again the moment anything it was folded
   * from changed. `spendFrom` and `runtimeFrom` are pure and both lists only
   * ever grow, so the same counts over the same range are the same answer —
   * the same reason `spendToday` is kept, one page further out.
   */
  private page(): Frame['spendView'] {
    const panel = this.wire.state.panel
    const live = this.wire.live
    if (panel?.kind !== 'spend' || !live) return null
    const now = this.wire.now()
    const key = `${panel.window}|${panel.by}|${live.spending.length}|${live.runs.length}`
    const folded = this.folded
    if (folded && folded.key === key && now - folded.at < REFOLD_MS) return folded.view
    const view = spendView(live.spending, {
      window: panel.window,
      by: panel.by,
      now,
      // The window's own moment, so an extension's page and this one mean the
      // same thing by "This window".
      openedAt: this.wire.openedAt,
      projects: projects(this.wire.state),
      runs: live.runs,
      plan: this.wire.opts.client.planUsage(),
      // What somebody says their models cost, over what Tade ships. Read off
      // the config each draw rather than kept: it is a handful of entries, and
      // a price held in a field is one that goes stale the moment it changes.
      prices: pricesFrom(this.wire.opts.config.prices),
      budgets: Object.fromEntries(
        Object.entries(this.wire.opts.config.projects).map(([name, project]) => [
          name,
          project.budget,
        ]),
      ),
    })
    this.folded = { key, at: now, view }
    return view
  }

  actions(): Actions {
    return {
      spend: () => {
        this.wire.put({ ...this.wire.state, panel: spendPanel() })
        this.wire.draw()
      },
      // Move the strip's plan bar to the next sign-in that has something to
      // say. What the strip shows is the one thing kept here rather than asked
      // again each draw: the tightest account is whichever is fullest now, and
      // a person who went to look at another one did not ask to be moved back
      // the moment somebody else's window filled up.
      'plan-next': () => {
        const standings = planStandings(this.wire.opts.client.planUsage(), this.wire.now())
        this.wire.put({
          ...this.wire.state,
          planShown: nextPlan(standings, this.wire.state.planShown),
        })
        this.wire.draw()
      },
    }
  }
}
