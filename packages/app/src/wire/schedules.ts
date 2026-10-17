import {
  bellDue,
  DEFAULT_MOST,
  type Decides,
  type DoneRule,
  decidesOf,
  describeWhen,
  joined,
  madeByWords,
  newFindings,
  type Schedule,
  type ScheduleDoes,
  scheduleIdOf,
  standingSchedules,
  type Watched,
  type WatchWhere,
  type When,
  watchedFrom,
} from '@tade/core'
import { type ExtensionHost, troubleOf, troubleUntil } from '@tade/extensions-core'
import { readEverMade } from '@tade/workbench/schedules'
import { acknowledge } from '../flash.ts'
import type { Frame } from '../frame.ts'
import { openSchedule, type ScheduleView, withTranscript } from '../model.ts'
import { scheduleMenuItems } from '../panels/menu/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import { foundMessage, scheduleView, scheduleViews } from '../queue.ts'
import { NEVER_RAN } from '../schedule-fold.ts'
import { hush, unhush } from '../schedules-view.ts'
import { problem, tadeDid } from '../transcript.ts'
import {
  type Actions,
  type Menus,
  notify,
  type Prompts,
  type Subject,
  type Wiring,
  whenShort,
  why,
} from './context.ts'
import { type Tellable, tellOrKeep } from './handed.ts'
import { Kept } from './kept.ts'
import { mayRun, type Network, networkOf, wasOffline } from './network.ts'
import { actOnFound, offerRun } from './proposals.ts'
import { mayWatch, type WatchTools, watchTools } from './watch-tools.ts'
import { noTwins, notLooking, type WatchTwinsHere, whereNow } from './watch-where.ts'

export type { WatchTools } from './watch-tools.ts'

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
  /** Who decides whether the work it makes starts: the orchestrator unless said (`DECIDES`). */
  decides?: Decides
  done?: DoneRule
  missed?: 'once' | 'skip'
  by?: string
}

/** What this subject needs from the rest of the window. */
export interface SchedulesDeps {
  /** Something happened the orchestrator has not heard yet: it goes with the next thing said. */
  news(said: string): void
  /**
   * The orchestrator, to tell now rather than with the next thing you say —
   * or, where it is not running or a tell fails, to keep as news and say so
   * (`tellOrKeep`), so what a schedule asks is never lost on the way. Asked
   * for at the moment of telling: the window makes it after this subject.
   */
  orchestrator(): Tellable
  /** Start whatever the queue can now start. */
  advanceQueue(): void
  /** What the links know of other machines' watches on one project's repository; none without. */
  twins?(project: string): WatchTwinsHere
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
  /** Watches a doorbell rang for while they were looking: one more look each, after (`wake`). */
  private readonly owed = new Set<string>()
  /**
   * What a delivery named for a look, per schedule, until a look has been
   * handed it: its line is appended when the wake comes and read back into the
   * fold a moment later, so the look the wake starts would otherwise miss it.
   */
  private readonly rung = new Map<string, Set<string>>()
  /** Whether this machine can reach a network: one answer, for every watch. */
  private readonly network: Network
  /** What `views` last made, kept: the fold asks for it every frame. */
  private readonly shown = new Kept<readonly ScheduleView[]>()

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
          acknowledge(
            { ...this.wire.state, panel: null },
            `now called ${kept?.name ?? text}`,
            this.wire.now(),
          ),
        )
      },
    }
  }

  /** Every schedule, as the SMART QUEUE shows it: kept until the journal moves or one comes due. */
  views(): readonly ScheduleView[] {
    const now = this.wire.now()
    const live = this.wire.live
    const due = (all: readonly ScheduleView[]) => all.some((one) => now >= (one.next[0] ?? now + 1))
    const made = () => scheduleViews(this.wire.opts.client.schedules(), live, now)
    return this.shown.of([live, live?.revision], made, due)
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
        notify(this.wire, `${id} ${said}`)
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

  /** Which machine looks with a watch in a project now (`watchWhere`): schedule `id`'s newest look, and the links. */
  where(project: string, watch: string, id: string, watched?: Watched): WatchWhere {
    const looks = () => watched ?? this.wire.live?.watchedOf(id) ?? null
    return whereNow(this.wire, project, watch, looks, this.deps.twins?.(project) ?? noTwins())
  }

  /** A watch another machine now looks with, whose newest look here did not leave it there. */
  private handedOver(one: Schedule): boolean {
    if (one.does.kind !== 'watch' || this.lookingWith.has(one.id)) return false
    const where = this.where(one.project, one.does.watch, one.id)
    if (where.here) return false
    return this.wire.live?.watchedOf(one.id).looks[0]?.on !== where.on
  }

  /** The schedule watching one watch in one project, or null when none is. */
  watching(watch: string, project: string): (Schedule & { paused: boolean }) | null {
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
    const where = this.where(project, watch, already?.id ?? '')
    if (on && already?.paused && !where.here) {
      throw new Error(`${offer.title} stays off in ${project}: ${where.said}`)
    }
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
    // One another machine looks with is not written: written, it would be
    // turned on here; unwritten, it is written the day it is this machine's.
    const ours = (made: readonly Schedule[]) =>
      made.filter(
        (one) => one.does.kind !== 'watch' || this.where(one.project, one.does.watch, one.id).here,
      )
    const there = new Set(this.wire.opts.client.schedules().map((one) => one.id))
    const now = this.wire.now()
    if (ours(standingSchedules(watches, projects, (id) => there.has(id), now)).length === 0) return
    const ever = readEverMade(this.wire.opts.home)
    const standing = ours(standingSchedules(watches, projects, (id) => ever.has(id), now))
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
      const { ran, runs } = live.runsOf(one.id)
      const last = Math.max(
        runs.at(-1)?.due ?? Number.NEGATIVE_INFINITY,
        this.fired.get(one.id) ?? Number.NEGATIVE_INFINITY,
      )
      // A watch a doorbell rings polls hourly while it does (`bellDue`, `hooks.ts`).
      const watched = one.does.kind === 'watch' ? live.watchedOf(one.id) : undefined
      const due = bellDue(one, Number.isFinite(last) ? last : null, ran, now, watched)
      if (!due) {
        // Another machine started looking with it: said now, not at its next look.
        if (this.handedOver(one)) await this.lookWith(one).catch((err) => this.wire.note(err))
        continue
      }
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
    const proposing = decidesOf(one.does) === 'orchestrator'
    const client = this.wire.opts.client
    const { task } = await client.fireSchedule(one.id, due, this.wire.now(), proposing)
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
    } else if (one.does.kind === 'agent' && proposing && task) {
      said = `${one.name} ran: ${offerRun(this.wire, this.deps.orchestrator(), one, task)}${missed}`
    } else if (one.does.kind === 'agent') {
      said = `${one.name} ran: ${task ?? 'its agent'} is queued${missed}`
      this.deps.advanceQueue()
    } else {
      said = `${one.name} ran: the orchestrator is asked${missed}`
      tellOrKeep(
        this.wire,
        this.deps.orchestrator(),
        `It is time for "${one.name}", a schedule ${madeByWords(one.by)} made to run ${describeWhen(one.when)}. ${one.does.kind === 'ask' ? one.does.prompt : ''}`,
        `"${one.name}" came due`,
      )
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
    const looking = this.doLookWith(one, asked).finally(() => {
      this.lookingWith.delete(one.id)
      if (this.owed.delete(one.id)) this.wake(one.id)
    })
    this.lookingWith.set(one.id, looking)
    return looking
  }

  /**
   * A delivery rang this watch's doorbell (`wire/doorbell.ts`): it looks now,
   * through the look its clock uses — or, where a look is under way, once more
   * after it, because the one under way may have read the source before the
   * thing the delivery was about. At most one owed, however many ring, which
   * is what bounds a burst of deliveries to a look and the next. Read again at
   * the wake, so a schedule paused or removed since is left alone.
   *
   * What a delivery named that a poll cannot see (`item`) is held for the
   * next look to be handed, beside the fold's own reading of the line.
   */
  wake(id: string, item?: string): void {
    const one = this.wire.opts.client.schedules().find((each) => each.id === id)
    if (!one || one.paused || one.does.kind !== 'watch') return
    if (item !== undefined) {
      const held = this.rung.get(id) ?? new Set<string>()
      this.rung.set(id, held)
      held.add(item)
    }
    if (this.lookingWith.has(id)) {
      this.owed.add(id)
      return
    }
    void this.lookWith(one).catch((err) => this.wire.note(err))
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
    // Its project is not open, or another machine looks with it: written down
    // as the quiet look it is rather than thrown as trouble, and said once
    // rather than a line every ten minutes (`watch-where.ts`).
    const where = this.where(one.project, does.watch, one.id, watched)
    const quiet = await notLooking(this.wire, one, watched, where, asked)
    if (quiet) return quiet.news ? say(quiet.said) : quiet.said
    let looked: Awaited<ReturnType<ExtensionHost['look']>>
    // What deliveries named that no look has read: the fold's, out of the
    // journal, and what came with a wake whose line it may not have read yet.
    // The ones handed over now are let go of when this look ends, by which
    // time their lines are in the fold whatever came of it.
    const handed = this.rung.get(one.id) ?? new Set<string>()
    const rang = [...new Set([...(watched.rang ?? []), ...handed])]
    const given = [...handed]
    try {
      const host = this.wire.opts.extensions
      if (!host) throw new Error('this window runs no extensions')
      looked = await host.look(does.watch, {
        project: one.project,
        input: does.input,
        since: watched.since,
        // Back from another machine, what came before it was that one's.
        turnedOn: watched.elsewhereAt ?? one.created,
        // A watch that looks at what Tade is running needs the window it is
        // running in; one that does not never asks for it.
        tade: this.wire.opts.extensionWorkbench ?? null,
        ...(rang.length > 0 ? { rang } : {}),
      })
    } catch (err) {
      for (const item of given) handed.delete(item)
      // No network is not a failed look: nothing written, nothing said beyond
      // the one line the reach has already said about being offline.
      if (await wasOffline(this.network, err, this.wire.now())) {
        return `${one.name} did not look: this machine cannot reach a network`
      }
      const reason = why(err)
      // **The kind is written down here because here is where the error is.**
      // `troubleOf` reads the three ways a connector can say which and never
      // the sentence, so a look at a repository whose README mentions rate
      // limits is not classified by its own content.
      const trouble = { trouble: troubleOf(err), until: troubleUntil(err) }
      await client.watchChecked(one.id, { problem: reason, ...trouble }).catch(() => {})
      const said = `${one.name} could not look: ${reason}`
      if (asked || watched.looks[0]?.problem !== reason) return say(said, true)
      return said
    }
    // It looked. Whatever was hushed about it was hushed about trouble that is
    // over, so the same words coming back later are news again.
    this.wire.put(unhush(this.wire.state, one.id))
    for (const item of given) handed.delete(item)
    const { fresh, acting, left } = newFindings(looked.found, watched.seen, does.most)
    await client.watchChecked(one.id, {
      found: looked.found.length,
      fresh: fresh.map((finding) => finding.key),
      left,
      since: left > 0 ? watched.since : looked.since,
      ...(looked.said ? { said: looked.said } : {}),
      // What it read of what deliveries named, let go of as `since` moves:
      // only by a look that left nothing for the next, which must find it again.
      ...(left === 0 && looked.read.length > 0 ? { read: looked.read } : {}),
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
        notify(this.wire, said)
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
      tellOrKeep(
        this.wire,
        this.deps.orchestrator(),
        foundMessage({
          name: one.name,
          watch: does.watch,
          project: one.project,
          who: madeByWords(one.by),
          found: acting,
          left,
        }),
        `${one.name} found something`,
      )
      const said = `${one.name} found ${fresh.length} new: the orchestrator is told${waits}`
      this.wire.put(
        withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, said, this.wire.now())),
      )
      this.wire.draw()
      return said
    }
    // What it found becomes work — parked for the orchestrator to decide, unless
    // the schedule decides itself and the watch lets it (`proposals.ts`).
    const { started, decided, failed, offered } = await actOnFound(this.wire, one, looked, acting, {
      orchestrator: this.deps.orchestrator(),
      itself: decidesOf(does) === 'itself',
      left,
    })
    if (started.length > 0) {
      await this.wire.live?.refresh()
      this.deps.advanceQueue()
    }
    const parts = [
      offered,
      started.length > 0 ? `queued ${joined(started)}` : '',
      decided.length > 0 ? decided.join('; ') : '',
      failed.length > 0 ? `could not start work on ${failed.join('; ')}` : '',
    ].filter(Boolean)
    return say(
      `${one.name} found ${fresh.length} new: ${parts.join('; ')}${waits}`,
      // Trouble only where something actually went wrong. A rule that said no
      // is Tade working, and drawing it red teaches people to ignore red.
      started.length === 0 && decided.length === 0 && !offered,
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
      if ((req.by ?? 'orchestrator') === 'orchestrator') await mayWatch(this.wire, offer, true)
      // And one machine per repository: another one looking with it means this one's stays off.
      const where = existing ? null : this.where(req.project, req.watch, id)
      if (where && !where.here)
        throw new Error(`${offer.title} stays off in ${req.project}: ${where.said}`)
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
        ...(req.decides ? { decides: req.decides } : {}),
      }
      when ??= { every: offer.every }
      // Turned on while its extension cannot look is allowed, and said.
      if (offer.problem) waits = ` It cannot look yet: ${offer.problem}.`
    } else if (req.ask !== undefined) {
      does = { kind: 'ask', prompt: req.ask }
    } else {
      does = {
        kind: 'agent',
        prompt: req.agent ?? '',
        ...(req.done ? { done: req.done } : {}),
        ...(req.decides ? { decides: req.decides } : {}),
      }
    }
    // Refused rather than kept: a word nothing would ever read.
    if (req.decides && decidesOf(does) === null) {
      throw new Error(
        'decides is about work a schedule starts, and one that asks or tells starts none',
      )
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
    const view = scheduleView(kept, this.wire.live?.runsOf(kept.id) ?? NEVER_RAN, now)
    this.wire.draw()
    const next = view.next.map((at) => whenShort(at, now))
    return `${kept.name} (${kept.id}): ${view.when}, ${view.does}. ${next.length > 0 ? `Next: ${next.join(', ')}.` : 'It has nothing left to run.'}${waits}`
  }

  /**
   * What the orchestrator's watch tools do, answered from this window, held to
   * `WATCH_REACH` (`watch-tools.ts`).
   */
  tools(): WatchTools {
    return watchTools(this.wire, this)
  }
}
