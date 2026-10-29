import { homedir } from 'node:os'
import { join } from 'node:path'
import type { App } from '@tade/app'
import { thinkerOffers } from '@tade/app/panels/menu/state'
import {
  activityFrom,
  type Config,
  effortsIn,
  finishedFrom,
  historyFrom,
  LOCAL,
  loadConfig,
  modelDetail,
  type ThinkingLevel,
  TOLD_EVENTS,
  type ToldPrint,
  tadeHome,
  unheardNotes,
} from '@tade/core'
import type { ExtensionHost, ExtensionWorkbench } from '@tade/extensions-core'
import type { HarnessModels } from '@tade/harnesses-core'
import {
  Orchestrator,
  type OrchestratorOptions,
  orchestratorExtensions,
  ToolHost,
  tellingOf,
} from '@tade/orchestrator'
import type { StatusCollector } from '@tade/status'
import type { Workbench } from '@tade/workbench'
import { livenessTableFrom } from '@tade/workbench/lane-liveness'

// The orchestrator, and the way back for its tools, for whatever holds the
// home: the window (`tade app`), or the window with no screen (`tade serve`).
//
// One of these for both, so that what the orchestrator is started with, what
// its tools reach and how it is started again can never say two things on two
// machines. It opens before what holds the home does — the socket has to exist
// for anything to be started on it — and every tool answers that Tade is still
// opening until it is handed that (`hold`); the orchestrator itself is started
// only once it is (`start`), because it is told what it missed out of the
// queue that holds it.

/**
 * What holds the home and answers the orchestrator's tools: the window, or the
 * heart alone (`@tade/app/heart`). The window's own parts — putting a terminal
 * in front, the files you attached, updating it, the links to other machines —
 * are optional, and a tool that needs one where there is none says so.
 */
export type Holding = Pick<
  App,
  | 'queueTools'
  | 'configTools'
  | 'watchTools'
  | 'awayTools'
  | 'attachThinker'
  | 'keepThinkerModel'
  | 'thinkerMovedTo'
  | 'thinkerFailed'
> &
  Partial<Pick<App, 'updateTools' | 'remoteTools' | 'handOff' | 'showTerminal'>>

export interface OrchestratingOptions {
  client: Workbench
  home: string
  /** The config file, read again at every start: a model chosen since is in the file. */
  configPath: string
  /** The config as it was loaded, for a start that cannot read the file again. */
  config: Config
  safe: boolean
  /** The look the window takes too, so `tade_status` is what a person reads. */
  looking: StatusCollector
  extensions: ExtensionHost
  /** What an extension may ask of whatever holds the home, once something does. */
  forExtensions: () => ExtensionWorkbench | null
  /**
   * What is said of a part of the window that what holds the home does not
   * have, after the part's name: `updating Tade` and this.
   */
  without: string
}

export interface Orchestrating {
  /** The socket its tools call back on, dead with whatever opened it. */
  readonly tools: ToolHost
  /** What holds the home, once it is up: until then every tool says Tade is still opening. */
  hold(holding: Holding): void
  /** Start it on what the config says now; said where it is waited for if it cannot be. */
  start(): void
  /** Start it again on what the config now says, carrying on its conversation. */
  restart(): Promise<void>
  /** What it would be told if it started now, its own notes since `since` left out. */
  toldNow(since: number): Promise<ToldPrint>
  /** What its own harness offers to run, or why there is nobody to ask yet. */
  models(): Promise<HarnessModels>
  /** Stopped where it is, and the socket closed: what closing names, each on its own. */
  closes(): { name: string; close: () => Promise<void> }[]
}

const opening = () => new Error('Tade is still opening: ask again in a moment')

/**
 * How many times it is started again for tools that did not connect, within
 * `TOOLS_AGAIN_MS`. A server that missed its deadline on a loaded machine
 * usually makes the next one, and the session it missed is without its tools
 * for good; a server that never comes up would be a restart a turn, for ever.
 */
export const TOOLS_AGAIN = 2
/** The stretch `TOOLS_AGAIN` is counted over: long enough to stop a loop, short enough for a later spell of load. */
export const TOOLS_AGAIN_MS = 60 * 60_000

/**
 * The times it was started again for its tools, with `now` among them — or
 * null when that would be one time too many within `TOOLS_AGAIN_MS`.
 */
export function againForToolsAt(before: readonly number[], now: number): number[] | null {
  const lately = before.filter((at) => at > now - TOOLS_AGAIN_MS)
  return lately.length >= TOOLS_AGAIN ? null : [...lately, now]
}

/** What holds the home, and its tools as it handed them over: asked for once, as they hold their own state. */
interface Held {
  holding: Holding
  queue: ReturnType<Holding['queueTools']>
  settings: ReturnType<Holding['configTools']>
  watches: ReturnType<Holding['watchTools']>
  updates: ReturnType<NonNullable<Holding['updateTools']>> | undefined
  remotes: ReturnType<NonNullable<Holding['remoteTools']>> | undefined
  away: ReturnType<Holding['awayTools']>
}

export async function orchestrating(o: OrchestratingOptions): Promise<Orchestrating> {
  const { client, home, extensions } = o
  let held: Held | null = null
  /** A part of what holds the home, or why it cannot be had. */
  const part = <T>(get: (one: Held) => T | undefined, what: string): T => {
    if (!held) throw opening()
    const got = get(held)
    if (got === undefined) throw new Error(`${what} ${o.without}`)
    return got
  }
  // The queue is what holds the home's to run, and it comes up after this.
  const queue = () => part((one) => one.queue, 'the queue')
  // The config is its too: a setting written has to be read back and used
  // everywhere that holds one, and the boundary saying what the orchestrator
  // may touch is checked there rather than in its own process.
  const settings = () => part((one) => one.settings, 'the settings')
  const watches = () => part((one) => one.watches, 'the watches')
  // Updating and reloading are the window's: the run is in a terminal it puts
  // in front, and the person's words are checked there.
  const updates = () => part((one) => one.updates, 'updating and reloading Tade')
  const remotes = () => part((one) => one.remotes, 'linking to other machines')
  const status = async () => {
    const answer = await o.looking.collect({
      config: client.config,
      now: Date.now(),
      home: homedir(),
      tadeHome: tadeHome(),
      cwd: process.cwd(),
      pr: false,
      lanes: await livenessTableFrom(client),
    })
    // A tool fails by throwing: a look that could not be had is said, never
    // answered with a workspace that has nothing in it.
    if (!answer.known) throw new Error(answer.why)
    return answer.workspace
  }

  // Held so it can be stopped on the way out, whenever it finishes coming up.
  // Typed explicitly: assigned only from inside a callback, which is not
  // something inference can see.
  let orchestrator: Orchestrator | null = null
  // Closing, for a start still under way: it is stopped where it is
  // (`Orchestrator.start`'s `signal`) rather than waited out and stopped.
  const quitting = new AbortController()
  let starting: Promise<void> = Promise.resolve()
  const stopOrchestrator = async () => {
    await orchestrator?.stop().catch(() => {})
  }

  // The way back for the orchestrator's own tools: it runs as pi in its own
  // process, so `tade_run_start` has to reach us somehow. One socket, named
  // after this process, gone when what opened it is.
  const tools = await ToolHost.listen({
    tade: client,
    path: join(home, 'runs', `tools-${process.pid}.sock`),
    // A terminal the orchestrator opens or runs something in comes to the
    // front of the window, where there is one.
    onTerminal: (terminal) => void held?.holding.showTerminal?.(terminal),
    // Files you attached go to the agents the orchestrator starts in answer.
    handOff: async (task) => (await held?.holding.handOff?.(task)) ?? { note: '', images: [] },
    queue: {
      describe: async () => queue().describe(),
      change: async (req) => queue().change(req),
      plan: async (plan) => queue().plan(plan),
      schedule: async (req) => queue().schedule(req),
      decide: async (req) => queue().decide(req),
    },
    config: {
      settings: async (find) => settings().settings(find),
      change: async (req) => settings().change(req),
      openProject: async (req) => settings().openProject(req),
      closeProject: async (req) => settings().closeProject(req),
      renameProject: async (req) => settings().renameProject(req),
      reorderProjects: async (req) => settings().reorderProjects(req),
      configureProject: async (req) => settings().configureProject(req),
    },
    watches: {
      list: async (find) => watches().watches(find),
      change: async (req) => watches().change(req),
    },
    // A race is a plan the queue starts, and its pick is checked there against
    // the person's own lines.
    race: {
      start: async (req) => queue().race.start(req),
      standing: async (req) => queue().race.standing(req),
      pick: async (req) => queue().race.pick(req),
    },
    // A replay is a plan the queue starts and paces, and starting one is
    // checked there against the person's own lines.
    replay: {
      start: async (req) => queue().replay.start(req),
      standing: async (req) => queue().replay.standing(req),
    },
    // Another machine's orchestrator, over the window's link to it, and
    // checked there against the person's own lines.
    remotes: {
      tell: async (req) => remotes().tell(req),
      // Work moved there, held to the same line of theirs.
      move: async (req) => remotes().move(req),
      // What another machine says of itself and its work, read the same way.
      status: async (machine) => remotes().status(machine),
      documents: async (req) => remotes().documents(req),
      intake: async (req) => remotes().intake(req),
      tool: async (req) => remotes().tool(req),
    },
    updates: {
      read: async (check) => updates().read(check),
      run: async (req) => updates().run(req),
      reload: async (req) => updates().reload(req),
    },
    status,
    // How far the turn in flight reaches, and what a narrowed one is answered
    // with. **A remote arm is impossible until something holds the home**: the
    // host reads `LOCAL` for every call, which is the right answer because
    // nothing from away can have arrived yet — the listener is the holder's too.
    remote: {
      arm: () => held?.away.arm() ?? LOCAL,
      seen: async (arm) => part((one) => one.away, 'the away view').seen(arm),
      refused: (arm, method, why) => held?.away.refused(arm, method, why),
    },
    orchestratorModel: async (model, said) => {
      // Among what the orchestrator's own harness offers, and kept for the
      // next start either way. Only its own: a model is resolved by the
      // harness it is for, so with nobody there to ask, the honest answer is
      // that there is nobody there to ask — pi's catalog is not Claude Code's
      // or Codex's to answer out of.
      const asked = settings()
      if (!orchestrator) throw opening()
      // It writes the orchestrator's own Model row, so it takes the person's
      // words that row takes, before anything is resolved.
      await asked.ownModelAsked()
      const chosen = await orchestrator.resolveModel(model)
      // And never off the provider it keeps: where its conversation is sent is
      // the person's to move, so that is refused before it is kept.
      asked.ownProviderHeld(chosen)
      held?.holding.thinkerMovedTo(chosen, said)
      // A harness that takes a model only when it starts is started again on
      // it, on the same conversation.
      if (orchestrator.capabilities.model !== 'live') await restart()
      return chosen
    },
    extensions: async (call) =>
      (
        await extensions.call(call.tool, call.input, {
          caller: { kind: 'orchestrator' },
          id: call.callId,
          tade: o.forExtensions(),
        })
      ).text,
  })

  // Everything it is started with, read again at every start: also what
  // `toldNow` composes, so the two can only differ by what really moved.
  const thinkerOptions = async (): Promise<OrchestratorOptions & { config: Config }> => {
    // Read again: a model chosen in the window is in the file, not in what was
    // loaded when this started.
    const now = await loadConfig(o.configPath)
    const config = now.ok ? now.config : o.config
    // The journal it opens on: what its own lessons are measured against, and
    // what it is told happened while it was not running.
    const journal = await client.events({ limit: 2_000 }).catch(() => [])
    return {
      home,
      socket: tools.path,
      runDir: join(home, 'orchestrator'),
      cwd: process.cwd(),
      config,
      // So it knows what you have told it, not just what it can do.
      notes: client.recallAll(),
      // And which of its own lessons still apply.
      activity: activityFrom(historyFrom(journal, Date.now()), Object.keys(config.projects)),
      journal,
      // What it was tracking: the queue's own words, so the briefing and
      // tade_queue can never say different things.
      queue: await held?.queue.describe().catch(() => ''),
      // And what spans repositories, which the journal alone cannot say: an
      // effort is the fold of the task files that name it, read out of the
      // same status answer everything else reads.
      efforts: effortsIn(
        (await status().catch(() => null))?.projects.flatMap((project) => project.tasks) ?? [],
        new Set(finishedFrom(journal).keys()),
      ),
      safe: o.safe,
      signal: quitting.signal,
      // What starting it had to say — its conversation not carried to the
      // account it runs as, a model it could not place — written down where
      // Tade's own trouble goes, rather than nowhere.
      onWarning: (message) => {
        void client.log.append({
          type: 'warning',
          task: null,
          detail: { message: `the orchestrator: ${message}` },
        })
      },
      onToolsMissing: () => againForTools(),
      extensions: orchestratorExtensions(extensions, home, config.orchestrator.harness),
      // What its conversation was told before, read for that alone: it may be
      // older than the briefing's two thousand lines.
      toldBefore: await client.events({ types: TOLD_EVENTS, limit: 20 }).catch(() => []),
      onUsage: ({ model, ...usage }) => {
        void client.log
          .append({
            type: 'usage',
            task: null,
            // The model written the one way everything writes it: what the
            // orchestrator costs is the same question as what an agent costs,
            // and a second spelling of one model here is a second row of it
            // on the Spend page.
            detail: { by: 'orchestrator', ...usage, ...modelDetail(model) },
          })
          .catch(() => {})
      },
    }
  }

  const startThinker = async (holding: Holding, after?: Orchestrator) => {
    const options = await thinkerOptions()
    const config = options.config
    return (
      Orchestrator.start({ ...options, ...(after ? { after } : {}) })
        .then(async (started) => {
          orchestrator = started
          holding.attachThinker({
            ask: (text, images = []) =>
              started.askFor(
                text,
                120_000,
                images.map(({ data, mimeType }) => ({ data, mimeType })),
              ),
            tell: (text) => started.tell(text),
            // Its thinking level, moved without restarting it: the
            // conversation carries on at the new level.
            setThinking: (level) => started.setThinking(level as ThinkingLevel),
            // Stopping a turn without ending the conversation, and what its
            // harness says about being asked to.
            interrupt: () => started.interrupt(),
            offers: thinkerOffers(config.orchestrator.harness, started.capabilities),
            onEvent: (listener) => started.onEvent(listener),
            // The away half: a turn under an arm, and the three questions
            // anything outside the window asks about one. All four are the
            // orchestrator's own, so there is no second answer to *whose turn
            // is this* anywhere.
            askFrom: (text, arm) => started.askFrom(text, arm),
            arm: () => started.arm,
            busy: () => started.busy,
            unarmed: () => started.unarmed,
            // Its conversation, kept short and told what it is told now: the
            // window decides when (`Keeping`), never mid-turn.
            compact: () => started.compact(),
            context: () => started.context,
            told: () => started.told,
          })
          // Nothing chosen, so the harness picked: keep what it picked, so the
          // next time an agent switches model the orchestrator does not follow.
          if (!config.orchestrator.model) {
            const model = await started.model().catch(() => null)
            if (model) holding.keepThinkerModel(model)
          }
        })
        // Said in the conversation, where you would have waited for an answer
        // — unless it was closing that stopped it.
        .catch((err: unknown) => {
          if (quitting.signal.aborted) return
          holding.thinkerFailed(err instanceof Error ? err.message : String(err))
        })
    )
  }

  // A new model for the orchestrator: the old one stops, and the new one
  // carries on the same conversation — its session id never changes, so there
  // is nothing to ask for beyond starting it again.
  const restart = async () => {
    const holding = held?.holding
    if (!holding) return
    await starting
    // Stopped first, so what it said last is in its conversation before that
    // is carried to another account, where one was chosen (`after`).
    const before = orchestrator ?? undefined
    await stopOrchestrator()
    orchestrator = null
    starting = startThinker(holding, before)
    await starting
  }

  // Started without its tools: started again on the same conversation once
  // the turn that found out is over — never cut across, since that turn is
  // answering somebody — and only so often (`TOOLS_AGAIN`).
  let againAt: number[] = []
  const againForTools = (): string => {
    const next = againForToolsAt(againAt, Date.now())
    if (!next) {
      return `Tade has started it again ${TOOLS_AGAIN} times in the last hour and they still did not connect, so it will not again by itself: once the machine is less busy, start the orchestrator again (switch its model, or reopen Tade).`
    }
    againAt = next
    const missing = orchestrator
    void (async () => {
      await starting
      const on = missing ?? orchestrator
      if (!on) return
      if (on.busy) {
        await new Promise<void>((resolve) => {
          const off = on.onIdle(() => {
            off()
            resolve()
          })
        })
      }
      // Already started again, or stopped, by somebody else meanwhile.
      if (orchestrator !== on || quitting.signal.aborted) return
      await restart()
    })().catch((err: unknown) => {
      void client.log.append({
        type: 'warning',
        task: null,
        detail: {
          message: `the orchestrator: starting it again for its tools failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
    })
    return `Tade is starting it again on the same conversation once this turn is over (${againAt.length} of ${TOOLS_AGAIN}); ask again then.`
  }

  return {
    tools,
    hold: (holding) => {
      held = {
        holding,
        queue: holding.queueTools(),
        settings: holding.configTools(),
        watches: holding.watchTools(),
        updates: holding.updateTools?.(),
        remotes: holding.remoteTools?.(),
        away: holding.awayTools(),
      }
    },
    start: () => {
      // The window does not wait for it: it is a model in another process and
      // takes a few seconds to come up, and if it never does — no model
      // configured yet — everything except free text still works, which is
      // the honest outcome.
      if (held) starting = startThinker(held.holding)
    },
    restart,
    toldNow: async (since) => {
      if (!held) throw opening()
      const options = await thinkerOptions()
      // Its own notes since `since` are in its conversation already.
      return tellingOf({ ...options, notes: unheardNotes(options.notes ?? [], since) }).told
    },
    // The orchestrator's own harness may offer other models than agents'.
    // Before it is up there is nobody to ask, which is said rather than
    // answered with somebody else's list.
    models: async () =>
      orchestrator
        ? await orchestrator.models()
        : {
            harness: o.config.orchestrator.harness,
            models: [],
            why: 'is still starting: ask again in a moment',
          },
    closes: () => [
      // An orchestrator still starting is stopped under its start, which then
      // settles at once — closing while it starts would otherwise leave a
      // model process behind with nothing to talk to, or wait for one.
      {
        name: 'the orchestrator',
        close: () => {
          quitting.abort()
          return starting.then(stopOrchestrator)
        },
      },
      { name: "the orchestrator's tools", close: () => tools.close() },
    ],
  }
}
