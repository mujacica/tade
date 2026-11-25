import { expandHome, type InboxRow, resolveRoute } from '@tade/core'
import type { WebSide } from '@tade/web'
import type { ScheduleView } from '../model.ts'
import { agentOffers } from '../panels/menu/state.ts'
import { type SideThere, sideAnswerOf } from '../side.ts'
import type { Wiring } from './context.ts'
import { hereOf } from './here.ts'

// The window's half of `/api/side` (`@tade/web`'s `side.ts`): one project of
// this machine's as this window would draw it, for another of the person's
// machines to draw it from as its own (`side.ts`).
//
// **Out of what the window already holds, and the same readers its own side
// uses**: the panes are its state's, the checkout is `hereOf` — the very
// function its FILES, CHANGES and GIT are read by — the notes are `Live`'s,
// the schedules and the requests the subjects' own, and the header is what
// `Routes` says of an agent here. So a project drawn there is drawn from the
// values it would be drawn from here, and nothing is a second reading of them.
//
// A tree nobody here has open is asked for by the asking (`Live.files`
// starts a look at it), and answered `null` — not looked at yet — until the
// look has landed, as the window's own FILES is the first time it is opened.

/** What it needs of the subjects that are not the wiring's own. */
export interface SideDeps {
  /** Every schedule, as SCHEDULES draws them here. */
  schedules: () => readonly ScheduleView[]
  /** Every request handed to this machine, and what an empty INTAKE says. */
  intake: () => { intake?: readonly InboxRow[]; intakeEmpty?: { short: string; long: string } }
}

/** How long what a task's harness offers is kept before it is asked again: an ask reads its task file. */
const OFFERS_MS = 30_000

export function sideFrom(wire: Wiring, deps: SideDeps): WebSide {
  const offered = new Map<string, { at: number; offers: SideOffers }>()
  const offersOf = async (task: string): Promise<SideOffers> => {
    const now = wire.now()
    const kept = offered.get(task)
    if (kept && now - kept.at < OFFERS_MS) return kept.offers
    const known = await wire.opts.client.agentHarness(task).catch(() => null)
    const offers = known
      ? { harness: known.harness, offers: agentOffers(known.harness, known.capabilities) }
      : null
    offered.set(task, { at: now, offers })
    return offers
  }
  return async (ask) => {
    const config = wire.opts.config
    const state = wire.state
    const configured = config.projects[ask.project]
    // Not open here is answered as nothing: the route says it is not there.
    if (configured === undefined && !state.panes.some((pane) => pane.project === ask.project)) {
      return null
    }
    const live = wire.live ?? null
    const focused =
      ask.agent !== null &&
      state.panes.some((pane) => pane.task === ask.agent && pane.project === ask.project)
        ? ask.agent
        : null
    const here = hereOf(
      { panes: state.panes, focused, project: ask.project, expanded: ask.expanded },
      live,
      configured ? expandHome(configured.root) : null,
      { files: ask.files },
    )
    const told = deps.intake()
    return sideAnswerOf({
      ask,
      panes: state.panes,
      looking: live?.hasLooked !== true,
      spent: live?.spendToday()?.byTask ?? null,
      here,
      notes: live?.notes(ask.project) ?? [],
      retired: live?.retiredNotes(ask.project) ?? [],
      schedules: deps.schedules(),
      intake: told.intake ?? [],
      intakeEmpty: told.intakeEmpty ?? {
        short: 'off',
        long: 'Work from outside this machine is off.',
      },
      agent: focused === null ? null : await agentOf(focused, ask.project),
    })
  }

  /** The header of an agent here, as `Routes` says it: what it runs on and what its harness offers. */
  async function agentOf(task: string, project: string): Promise<SideThere['agent']> {
    const route = resolveRoute(wire.opts.config, { project })
    const known = await offersOf(task)
    return {
      task,
      route: {
        harness: known?.harness ?? route.harness,
        model: route.model ?? null,
        thinking: route.thinking ?? null,
        provider: route.provider ?? null,
      },
      vitals: wire.live?.vitals(task) ?? null,
      offers: known?.offers ?? null,
    }
  }
}

type SideOffers = { harness: string; offers: ReturnType<typeof agentOffers> } | null
