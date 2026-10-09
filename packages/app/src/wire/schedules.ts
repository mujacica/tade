import {
  DEFAULT_MOST,
  type DoneRule,
  describeWhen,
  dueNow,
  joined,
  LINES_LOOKED_BACK,
  newFindings,
  nothingToWatch,
  type Schedule,
  type ScheduleDoes,
  scheduleIdOf,
  standingSchedules,
  taskOrigin,
  WATCH_REACH,
  type When,
  watchedFrom,
  watchNamedBy,
} from '@tade/core'
import type { ExtensionHost, Finding } from '@tade/extensions-core'
import { readEverMade } from '@tade/workbench/schedules'
import type { Frame } from '../frame.ts'
import { notice, openSchedule, type ScheduleView, withTranscript } from '../model.ts'
import { scheduleMenuItems } from '../panels/menu/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import { foundMessage, scheduleView, watchesListed } from '../queue.ts'
import { hush, unhush } from '../schedules-view.ts'
import { problem, tadeDid } from '../transcript.ts'
import {
  type Actions,
  type Menus,
  type Prompts,
  type Subject,
  saidLately,
  type Wiring,
  whenShort,
  why,
} from './context.ts'
import { sayBackFor } from './intake-reply.ts'
import { mayRun, type Network, networkOf, wasOffline } from './network.ts'

/** What a schedule's row and its menu offer to do to it. */
const CHANGES = ['open', 'run', 'pause', 'resume', 'remove', 'rename'] as const

// Schedules are told, like notes, and run only while a window is open.
//
// There is no daemon: what is due is the rule, the journal and the clock, and
// runs that came due while no window was open are caught up once or skipped,
// as the schedule says, never once per run missed. A watch is a schedule that
// looks before it acts — Tade keeps where each look left off and every key
// found, so one finding never starts work twice, a start that failed included.
//
// A watch that reaches the network also reads one thing it does not own: the
// machine's reach for a network (`network.ts`). With none, its look does not
// happen at all — not a failed look, and not a red line per watch per timer.

/** What the orchestrator's watch tools do, answered from this window. */
export interface WatchTools {
  watches(find: string): Promise<string>
  change(req: { watch: string; project: string; on: boolean; said: string }): Promise<string>
}

/** What a schedule is asked for, in the words the orchestrator's tool takes. */
export interface ScheduleRequest {
  name: string
  project: string
  said: string
  /** When it runs; for a watch, how often it looks, which is the watch's own unless said. */
  when?: When
  /** Start an agent each time, told this. */
  agent?: string
  /** Ask the orchestrator this each time. */
  ask?: string
  /** Look with an extension's watch each time: `<extension>.<id>`. */
  watch?: string
  /** What the watch is turned on with. */
  input?: Readonly<Record<string, unknown>>
  /** What each new thing a watch finds becomes: an agent on it, or a question for the orchestrator. */
  found?: 'agent' | 'ask'
  /** At most this many new things acted on from one look. */
  most?: number
  done?: DoneRule
  missed?: 'once' | 'skip'
  by?: string
}

/** Who made a schedule, in words for the orchestrator. */
function askedByWords(by: string): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? 'the person' : origin.kind === 'orchestrator' ? 'you' : origin.name
}

/** What this subject needs from the rest of the window. */
export interface SchedulesDeps {
  /** Something happened the orchestrator has not heard yet: it goes with the next thing said. */
  news(said: string): void
  /** Tell the orchestrator now rather than with the next thing you say. */
  tell(text: string): Promise<void>
  /** Start whatever the queue can now start. */
  advanceQueue(): void
}

export class Schedules implements Subject {
  private readonly wire: Wiring
  private readonly deps: SchedulesDeps
  /** The schedules pass under way, if one is. */
  private pass: Promise<void> | null = null
  /** When each schedule was last run from this window, before the journal says so. */
  private readonly fired = new Map<string, number>()
  /** Watches looking now, so a slow look is never started twice. */
  private readonly lookingWith = new Map<string, Promise<string>>()
  /** Whether this machine can reach a network: one answer, for every watch. */
  private readonly network: Network

  constructor(wire: Wiring, deps: SchedulesDeps) {
    this.wire = wire
    this.deps = deps
    this.network = networkOf(wire, (said) => deps.news(said))
  }

  /** Every schedule, as the SMART QUEUE shows it. */
  facts(): Partial<Frame> {
    return { schedules: this.views() }
  }

  /**
   * One key per change rather than one pattern over them all: a table says
   * what there is, and a regular expression says only what it happens to match.
   */
  actions(): Actions {
    return {
      ...Object.fromEntries(
        CHANGES.map((change) => [
          `schedule-${change}:`,
          (id: string) => this.onSchedule(id, change),
        ]),
      ),
      // Reading a watch's trouble and saying so. Nothing about the watch
      // changes: what is hushed is the sentence on its row, for as long as the
      // reason stays that reason — so the reason is read here rather than
      // passed in, and the row can never hush one failure by naming another.
      'schedule-hush:': (id: string) => {
        const reason = this.views().find((one) => one.id === id)?.watch?.looks[0]?.problem
        if (reason) this.wire.put(hush(this.wire.state, id, reason))
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      schedule: {
        title: (subject) => this.views().find((one) => one.id === subject.id)?.name ?? 'Schedule',
        items: (subject) => {
          const one = this.views().find((view) => view.id === subject.id)
          return one ? scheduleMenuItems(one) : []
        },
        choose: (subject, item) => this.onSchedule(subject.id, item.slice('schedule-'.length)),
      },
    }
  }

  prompts(): Prompts {
    return {
      'rename-schedule': async (panel, text) => {
        if (!panel.target) return
        const kept = await this.wire.opts.client.changeSchedule({
          id: panel.target,
          change: 'rename',
          name: text,
          by: 'you',
        })
        this.wire.put(
          notice({ ...this.wire.state, panel: null }, `now called ${kept?.name ?? text}`),
        )
      },
    }
  }

  /** Every schedule, as the SMART QUEUE shows it. */
  views(): ScheduleView[] {
    const now = this.wire.now()
    return this.wire.opts.client
      .schedules()
      .map((one) =>
        scheduleView(
          one,
          this.wire.live?.runsOf(one.id) ?? [],
          now,
          one.does.kind === 'watch' ? this.wire.live?.watchedOf(one.id) : undefined,
        ),
      )
  }

  /** What is done to a schedule from the window: yours, and at once. */
  async onSchedule(id: string, change: string): Promise<void> {
    try {
      if (change === 'open') {
        this.wire.put(openSchedule(this.wire.state, id))
      } else if (change === 'rename') {
        const name = this.views().find((one) => one.id === id)?.name ?? ''
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('rename-schedule', 'Rename schedule', 'NAME', name),
            target: id,
          },
        })
      } else if (change === 'run') {
        await this.runNow(id, true)
      } else if (change === 'pause' || change === 'resume' || change === 'remove') {
        await this.wire.opts.client.changeSchedule({ id, change, by: 'you' })
        if (change === 'remove' && this.wire.state.schedule === id) {
          this.wire.put({ ...this.wire.state, schedule: null })
        }
        const said =
          change === 'remove' ? 'is removed' : change === 'pause' ? 'is paused' : 'is back on'
        this.wire.put(notice(this.wire.state, `${id} ${said}`))
      }
    } catch (err) {
      this.wire.note(err)
    }
    this.wire.draw()
  }

  /** Run one schedule now, because somebody asked for it. */
  async runNow(id: string, asked: boolean): Promise<string> {
    const one = this.wire.opts.client.schedules().find((each) => each.id === id)
    if (!one) throw new Error(`there is no schedule called ${id}`)
    return this.fire(one, { run: true, due: this.wire.now(), missed: 0 }, { asked })
  }

  /** The schedule watching one watch in one project, or null when none is. */
  private watching(watch: string, project: string): (Schedule & { paused: boolean }) | null {
    return (
      this.wire.opts.client
        .schedules()
        .find(
          (one) => one.project === project && one.does.kind === 'watch' && one.does.watch === watch,
        ) ?? null
    )
  }

  /**
   * Turn a watch the other way in a project, as you: what the button on the
   * Extensions page presses.
   *
   * Which way it goes is read here rather than by whoever drew the button, so
   * that the label and the act can never disagree about what is running.
   */
  async toggleWatch(watch: string, project: string): Promise<string> {
    const already = this.watching(watch, project)
    return this.turnWatch(watch, project, already === null || already.paused, 'you')
  }

  /**
   * Turn a watch on or off in a project: the one act behind the button on the
   * Extensions page and the orchestrator's own tool.
   *
   * On, with nothing watching it yet, writes a schedule named for the watch —
   * or for the watch and the project, where that name is taken by another
   * project — looking as often as the watch says. On again, having been turned
   * off, resumes the one that is there.
   *
   * **Off pauses it; it never takes it away.** A watch remembers what it has
   * found through its schedule's id, so a removed-and-remade watch would come
   * back with no memory and start work on everything it had already dealt
   * with. Paused, it is still in the queue, still says what it is, and comes
   * back exactly where it was. Removing one is a person's, in the queue.
   */
  async turnWatch(
    watch: string,
    project: string,
    on: boolean,
    by: string,
    said = '',
  ): Promise<string> {
    const offer = this.wire.opts.extensions?.watches().find((one) => one.id === watch)
    if (!offer) throw new Error(`there is no watch called ${watch}`)
    const already = this.watching(watch, project)
    if (already) {
      if (already.paused !== on) {
        return `${already.name} is already ${on ? 'on' : 'off'} in ${project}`
      }
      const kept = await this.wire.opts.client.changeSchedule({
        id: already.id,
        change: on ? 'resume' : 'pause',
        by,
      })
      this.wire.draw()
      const name = kept?.name ?? already.name
      return on
        ? `${name} is back on in ${project}: it looks ${describeWhen(already.when)}`
        : `${name} is off in ${project} — it is paused in the queue, and keeps what it has already found`
    }
    if (!on) return `nothing is watching ${offer.title.toLowerCase()} in ${project}`
    const taken = this.wire.opts.client
      .schedules()
      .some((one) => one.id === scheduleIdOf(offer.title) && one.project !== project)
    const name = taken ? `${offer.title} in ${project}` : offer.title
    await this.set({ name, project, said, watch, by })
    const view = this.views().find((one) => one.id === scheduleIdOf(name))
    const first = view?.next[0]
    const when = first === undefined ? '' : `, first at ${whenShort(first, this.wire.now())}`
    const yet = offer.problem ? `; it cannot look yet: ${offer.problem}` : ''
    return `${name} is on in ${project}: it looks ${view?.when ?? `every ${offer.every}`}${when}${yet}`
  }

  /**
   * Run the schedules that are due, by rule, on every look at the tasks: only
   * while this window is open, catching up once, or skipping, for what came due
   * while none was. One pass at a time, so nothing runs twice.
   */
  runDue(): Promise<void> {
    this.pass ??= this.doRunDue().finally(() => {
      this.pass = null
    })
    return this.pass
  }

  /**
   * Write the watches that are on without anybody turning one on, once each.
   *
   * The rule is `standingSchedules` and it is all of it: a watch that says it
   * stands, an extension that can look right now, and an id nothing has ever
   * been written under in this project. With no key the extension is not
   * ready, so there is no schedule, no look and nothing in the journal — which
   * is the whole of "with no key nothing runs and nothing else changes".
   * Written, it is an ordinary schedule: it is in the queue, it can be paused,
   * changed or removed, and removed it stays removed.
   */
  private async writeStanding(): Promise<void> {
    const host = this.wire.opts.extensions
    if (!host) return
    const watches = host.watches()
    const projects = Object.keys(this.wire.opts.config.projects)
    // Twice, cheaply then exactly. Against the schedules there are, which are
    // already in hand, this is a set lookup and after the first look it comes
    // back empty — so the file behind the second question is read only on the
    // looks where something might actually be written.
    const there = new Set(this.wire.opts.client.schedules().map((one) => one.id))
    if (standingSchedules(watches, projects, (id) => there.has(id), this.wire.now()).length === 0) {
      return
    }
    const ever = readEverMade(this.wire.opts.home)
    const standing = standingSchedules(watches, projects, (id) => ever.has(id), this.wire.now())
    for (const schedule of standing) {
      try {
        const kept = await this.wire.opts.client.setSchedule(schedule, schedule.by)
        // Said where you would look: a schedule nobody asked for is exactly
        // the kind of thing somebody has to be able to find and undo.
        const said = `${kept.name} is on in ${kept.project}, ${describeWhen(kept.when)} — turn it off in the queue if you would rather it did not.`
        this.deps.news(said)
        this.wire.put(
          withTranscript(
            this.wire.state,
            tadeDid(this.wire.state.transcript, said, this.wire.now()),
          ),
        )
      } catch (err) {
        this.wire.note(err)
      }
    }
  }

  private async doRunDue(): Promise<void> {
    const live = this.wire.live
    if (!live) return
    await this.writeStanding()
    const now = this.wire.now()
    const watches = this.wire.opts.extensions?.watches() ?? []
    for (const one of this.wire.opts.client.schedules()) {
      if (one.paused) continue
      const runs = live.runsOf(one.id)
      const last = Math.max(
        runs.at(-1)?.due ?? Number.NEGATIVE_INFINITY,
        this.fired.get(one.id) ?? Number.NEGATIVE_INFINITY,
      )
      const due = dueNow(
        one,
        Number.isFinite(last) ? last : null,
        runs.filter((run) => run.ran).length,
        now,
      )
      if (!due) continue
      if (due.run && !(await mayRun(this.network, one.does, watches, now))) continue
      await this.fire(one, due).catch((err) => {
        this.wire.put(
          withTranscript(
            this.wire.state,
            problem(
              this.wire.state.transcript,
              `${one.name} could not run: ${why(err)}`,
              this.wire.now(),
            ),
          ),
        )
      })
    }
  }

  /**
   * One run of a schedule: written down first, then done — its agent's work
   * queued, or the orchestrator asked — and said where you would look.
   */
  async fire(
    one: Schedule & { paused: boolean },
    due: { run: boolean; due: number; missed: number },
    how: { asked?: boolean } = {},
  ): Promise<string> {
    this.fired.set(one.id, due.due)
    const { task } = await this.wire.opts.client.fireSchedule(one.id, due, this.wire.now())
    const missed =
      due.missed > 0
        ? `, ${due.missed} run${due.missed === 1 ? '' : 's'} missed while Tade was closed`
        : ''
    let said: string
    if (!due.run) {
      said = `${one.name} skipped what came due while Tade was closed${missed}`
    } else if (one.does.kind === 'watch') {
      // Looking is not news; what it finds is, and the look says it. One asked
      // for is waited on, so whoever asked hears what it found, nothing included.
      const looking = this.lookWith(one, how.asked === true)
      return how.asked ? await looking : ''
    } else if (one.does.kind === 'agent') {
      said = `${one.name} ran: ${task ?? 'its agent'} is queued${missed}`
      this.deps.advanceQueue()
    } else {
      said = `${one.name} ran: the orchestrator is asked${missed}`
      const who = askedByWords(one.by)
      void this.deps
        .tell(
          `It is time for "${one.name}", a schedule ${who} made to run ${describeWhen(one.when)}. ${one.does.kind === 'ask' ? one.does.prompt : ''}`,
        )
        .catch(() => {})
    }
    this.deps.news(said)
    this.wire.put(
      withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, said, this.wire.now())),
    )
    this.wire.draw()
    return said
  }

  /**
   * One look with a watch. What it found is written down first; then what is
   * new, as far as the most one look acts on, becomes queued work — or is told
   * to the orchestrator — and the rest waits for the next look, which starts
   * where this one did so it finds them again. Said where you would look, except
   * a look nobody asked for that found nothing new; one that could not look is
   * said when it starts going wrong, not at every look while it stays wrong.
   * One look at a time per watch: a slow one is never started twice.
   */
  lookWith(one: Schedule & { paused: boolean }, asked = false): Promise<string> {
    const running = this.lookingWith.get(one.id)
    if (running) return running
    const looking = this.doLookWith(one, asked).finally(() => this.lookingWith.delete(one.id))
    this.lookingWith.set(one.id, looking)
    return looking
  }

  private async doLookWith(one: Schedule & { paused: boolean }, asked: boolean): Promise<string> {
    const does = one.does
    if (does.kind !== 'watch') return ''
    const client = this.wire.opts.client
    const watched = this.wire.live?.watchedOf(one.id) ?? watchedFrom([], one.id)
    const say = (said: string, bad = false) => {
      this.deps.news(said)
      this.wire.put(
        withTranscript(
          this.wire.state,
          bad
            ? problem(this.wire.state.transcript, said, this.wire.now())
            : tadeDid(this.wire.state.transcript, said, this.wire.now()),
        ),
      )
      this.wire.draw()
      return said
    }
    // Its project is not one Tade is working in any more, so there is nothing
    // to look at. Written down as the quiet look it is rather than thrown as
    // trouble: the watch keeps everything it has found, comes back the moment
    // the project is opened again, and says this once instead of a red line
    // every ten minutes about a project somebody closed on purpose.
    const nothing = nothingToWatch(one.project, Object.keys(this.wire.opts.config.projects))
    if (nothing) {
      this.wire.put(unhush(this.wire.state, one.id))
      await client
        .watchChecked(one.id, {
          found: 0,
          fresh: [],
          left: 0,
          since: watched.since,
          said: nothing,
        })
        .catch(() => {})
      const said = `${one.name}: ${nothing}`
      if (asked || watched.looks[0]?.said !== nothing) return say(said)
      return said
    }
    let looked: Awaited<ReturnType<ExtensionHost['look']>>
    try {
      const host = this.wire.opts.extensions
      if (!host) throw new Error('this window runs no extensions')
      looked = await host.look(does.watch, {
        project: one.project,
        input: does.input,
        since: watched.since,
        turnedOn: one.created,
        // A watch that looks at what Tade is running needs the window it is
        // running in; one that does not never asks for it.
        tade: this.wire.opts.extensionWorkbench ?? null,
      })
    } catch (err) {
      // No network is not a failed look: nothing written, nothing said beyond
      // the one line the reach has already said about being offline.
      if (await wasOffline(this.network, err, this.wire.now())) {
        return `${one.name} did not look: this machine cannot reach a network`
      }
      const reason = why(err)
      await client.watchChecked(one.id, { problem: reason }).catch(() => {})
      const said = `${one.name} could not look: ${reason}`
      if (asked || watched.looks[0]?.problem !== reason) return say(said, true)
      return said
    }
    // It looked. Whatever was hushed about it was hushed about trouble that is
    // over, so the same words coming back later are news again.
    this.wire.put(unhush(this.wire.state, one.id))
    const { fresh, acting, left } = newFindings(looked.found, watched.seen, does.most)
    await client.watchChecked(one.id, {
      found: looked.found.length,
      fresh: fresh.map((finding) => finding.key),
      left,
      since: left > 0 ? watched.since : looked.since,
      ...(looked.said ? { said: looked.said } : {}),
    })
    // A look with nothing to look at may say so, and it is not a failure: a
    // branch nobody has pushed is a quiet fact about that branch, so it is said
    // in Tade's own voice rather than drawn as trouble. Held to the same rule as
    // a look that could not look — said when it starts being true and not at
    // every look for as long as it stays true — because the whole reason this is
    // not a `problem` is that it was being shouted every ten minutes.
    if (looked.said && (asked || watched.looks[0]?.said !== looked.said)) {
      say(`${one.name}: ${looked.said}`)
    }
    if (acting.length === 0) {
      const said = `${one.name} looked: ${looked.found.length === 0 ? 'found nothing' : 'nothing new'}`
      if (asked) {
        this.wire.put(notice(this.wire.state, said))
        this.wire.draw()
      }
      return said
    }
    const waits =
      left > 0 ? `; ${left} more ${left === 1 ? 'waits' : 'wait'} for its next look` : ''
    if (does.found === 'ask') {
      for (const finding of acting) {
        await client.watchFound(one.id, finding, { told: 'orchestrator' }).catch(() => {})
      }
      void this.deps
        .tell(
          foundMessage({
            name: one.name,
            watch: does.watch,
            project: one.project,
            who: askedByWords(one.by),
            found: acting,
            left,
          }),
        )
        .catch(() => {})
      const said = `${one.name} found ${fresh.length} new: the orchestrator is told${waits}`
      this.wire.put(
        withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, said, this.wire.now())),
      )
      this.wire.draw()
      return said
    }
    const started: string[] = []
    const failed: string[] = []
    // What was found and deliberately not started on: a request the owner's own
    // rule refused, one held for a person to answer, one waiting to be tried
    // again. None of those is a failed start, and reading them as one is how a
    // rule working exactly as written looks like something going wrong.
    const decided: string[] = []
    for (const finding of acting) {
      try {
        const agent = await looked.agent(finding).catch(async (err: unknown) => {
          // Written down as found, with why: tried again at every look, it would say so at every look.
          await client.watchFound(one.id, finding, { problem: why(err) }).catch(() => {})
          throw err
        })
        const { task, said, outcome } = await client.watchFound(one.id, finding, {
          agent: { ...agent, links: agent.links ?? finding.links ?? [] },
        })
        if (task) started.push(task)
        else if (said) decided.push(said)
        if (outcome === 'accepted' || outcome === 'adopted') {
          const quiet = await sayBackFor({
            client,
            config: this.wire.opts.config,
            host: this.wire.opts.extensions ?? null,
            now: this.wire.now(),
            schedule: one,
            watch: does.watch,
            finding,
            task,
          })
          if (quiet) this.deps.news(`${one.name} could not say anything back: ${quiet}`)
        }
      } catch (err) {
        failed.push(`${finding.title} (${why(err)})`)
      }
    }
    if (started.length > 0) {
      await this.wire.live?.refresh()
      this.deps.advanceQueue()
    }
    const parts = [
      started.length > 0 ? `queued ${joined(started)}` : '',
      decided.length > 0 ? decided.join('; ') : '',
      failed.length > 0 ? `could not start work on ${failed.join('; ')}` : '',
    ].filter(Boolean)
    return say(
      `${one.name} found ${fresh.length} new: ${parts.join('; ')}${waits}`,
      // Trouble only where something actually went wrong. A rule that said no
      // is Tade working, and drawing it red teaches people to ignore red.
      started.length === 0 && decided.length === 0,
    )
  }

  /**
   * Make a schedule, or change the one that name already belongs to.
   *
   * Here rather than in the queue's tools because all of it is about
   * schedules: which of the three things it does each time, what a watch was
   * turned on with, and when it runs — which a watch has an answer to of its
   * own, so it need not be said.
   */
  async set(req: ScheduleRequest): Promise<string> {
    const now = this.wire.now()
    const id = scheduleIdOf(req.name)
    const existing = this.wire.opts.client.schedules().find((one) => one.id === id)
    const ways = [req.agent, req.ask, req.watch].filter((way) => way !== undefined)
    if (ways.length !== 1) {
      throw new Error(
        'say what it does each time with one of: agent (what to tell it), ask, or watch',
      )
    }
    let does: ScheduleDoes
    let when = req.when
    let waits = ''
    if (req.watch !== undefined) {
      const host = this.wire.opts.extensions
      const offer = host?.watches().find((one) => one.id === req.watch)
      const refused = host
        ? host.watchProblem(req.watch, req.input ?? {})
        : 'this window runs no extensions'
      if (refused || !offer) throw new Error(refused ?? `there is no watch called ${req.watch}`)
      // The boundary, at the one door every way of turning a watch on goes
      // through. `tade_watch_change` has already asked this and asks it again
      // here on purpose: `tade_schedule` writes a watch schedule too, and a
      // rule with a door beside it that nobody guards is worse than no rule,
      // because it reads like a promise. Nothing here gates an agent or an
      // ask schedule — those are the queue's, and always were.
      if ((req.by ?? 'orchestrator') === 'orchestrator') await this.mayWatch(offer, true)
      if (req.most !== undefined && !(Number.isInteger(req.most) && req.most > 0)) {
        throw new Error('most is how many new things one look acts on: a whole number, 1 or more')
      }
      does = {
        kind: 'watch',
        watch: req.watch,
        input: { ...(req.input ?? {}) },
        // What the watch says it is for, unless somebody said otherwise.
        found: req.found ?? offer.offers,
        // The watch's own number where it has one, as `standingSchedules` uses
        // it: what is right for a watch that starts agents is not what is right
        // for one that asks a question.
        most: req.most ?? offer.most ?? DEFAULT_MOST,
      }
      when ??= { every: offer.every }
      // Turned on while its extension cannot look is allowed, and said.
      if (offer.problem) waits = ` It cannot look yet: ${offer.problem}.`
    } else if (req.ask !== undefined) {
      does = { kind: 'ask', prompt: req.ask }
    } else {
      does = { kind: 'agent', prompt: req.agent ?? '', ...(req.done ? { done: req.done } : {}) }
    }
    if (does.kind !== 'watch' && !does.prompt.trim()) {
      throw new Error('say what it does each time: agent (what to tell it) or ask')
    }
    if (!when) throw new Error('say when it runs: at, every or cron')
    const kept = await this.wire.opts.client.setSchedule(
      {
        id,
        name: req.name,
        project: req.project,
        said: req.said,
        when,
        does,
        missed: req.missed ?? 'once',
        by: req.by ?? 'orchestrator',
        // Kept when it is changed: intervals count from when it was made.
        created: existing?.created ?? new Date(now).toISOString(),
      },
      req.by ?? 'orchestrator',
    )
    const view = scheduleView(kept, this.wire.live?.runsOf(kept.id) ?? [], now)
    this.wire.draw()
    const next = view.next.map((at) => whenShort(at, now))
    return `${kept.name} (${kept.id}): ${view.when}, ${view.does}. ${next.length > 0 ? `Next: ${next.join(', ')}.` : 'It has nothing left to run.'}${waits}`
  }

  /**
   * What the orchestrator's watch tools do, answered from this window.
   *
   * The boundary is `WATCH_REACH` in core and it is enforced here rather than
   * in the tool, for the reason the settings boundary is: the tool runs inside
   * the model's own process, and a rule that lives where the model lives is a
   * rule the model can be talked out of. It may only ever refuse — everything
   * it allows, the button on the Extensions page already allowed.
   */
  tools(): WatchTools {
    return {
      watches: async (find) =>
        watchesListed({
          offers: this.wire.opts.extensions?.watches() ?? [],
          projects: Object.keys(this.wire.opts.config.projects),
          watching: (watch, project) => this.watching(watch, project),
          find,
        }),
      change: async (req) => this.askedWatch(req),
    }
  }

  /**
   * Turn a watch on or off on somebody's behalf, or say why not.
   *
   * The same three things that hold for a setting: Tade has to offer the watch
   * at all, the boundary has to reach it, and the person has to have asked for
   * *this* watch in their own words. That last check reads the journal, not
   * the argument — `said` is the orchestrator's account of what was asked and
   * is written down beside the change, and what authorises it is a line the
   * person themselves typed or spoke. A page can tell a model to turn the
   * review watch off. It cannot put "turn the review watch off" in somebody's
   * mouth.
   */
  private async askedWatch(req: {
    watch: string
    project: string
    on: boolean
    said: string
  }): Promise<string> {
    const watch = req.watch.trim()
    const offer = this.wire.opts.extensions?.watches().find((one) => one.id === watch)
    if (!offer) {
      throw new Error(
        `Tade has no watch called ${watch}. tade_watches lists every one there is, by the id this takes.`,
      )
    }
    const project = req.project.trim()
    if (!this.wire.opts.config.projects[project]) {
      throw new Error(
        `${project || 'no project'} is not a project Tade has open. A watch runs in one, so say which.`,
      )
    }
    if (req.said.trim() === '') {
      throw new Error(
        `${offer.title} only goes ${req.on ? 'on' : 'off'} when somebody asks for it. Pass what they said, word for word.`,
      )
    }
    await this.mayWatch(offer, req.on)
    return this.turnWatch(watch, project, req.on, 'orchestrator', req.said.trim())
  }

  /**
   * Whether the orchestrator may turn this watch, or why not.
   *
   * The rule is `WATCH_REACH` in core and the check is the journal's: what
   * authorises it is a line the *person* typed or spoke, kept verbatim, which
   * nothing an agent read can ever become. It may only ever refuse.
   */
  private async mayWatch(offer: { id: string; title: string }, on: boolean): Promise<void> {
    const { reach, because } = WATCH_REACH
    const way = on ? 'on' : 'off'
    if (reach === 'never') {
      throw new Error(
        `${offer.title} is not mine to turn ${way}: ${because}. A person does it on the Extensions page or in the queue.`,
      )
    }
    if (reach !== 'asked') return
    const line = watchNamedBy(offer, await saidLately(this.wire, LINES_LOOKED_BACK))
    if (!line) {
      throw new Error(
        `Nothing they have said names ${offer.title}, so I will not turn it ${way} — ${because}. Ask them plainly: "${offer.title.toLowerCase()}" said back to you is enough.`,
      )
    }
  }
}
