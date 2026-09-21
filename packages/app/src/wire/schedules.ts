import {
  type DoneRule,
  describeWhen,
  dueNow,
  joined,
  newFindings,
  type Schedule,
  type ScheduleDoes,
  taskOrigin,
  type When,
  watchedFrom,
} from '@tade/core'
import type { ExtensionHost } from '@tade/extensions-core'
import { notice, openSchedule, type ScheduleView, withTranscript } from '../model.ts'
import { promptPanel } from '../panels/small/state.ts'
import { foundMessage, scheduleView } from '../queue.ts'
import { problem, tadeDid } from '../transcript.ts'
import { type Wiring, whenShort, why } from './context.ts'

// Schedules are told, like notes, and run only while a window is open.
//
// There is no daemon: what is due is the rule, the journal and the clock, and
// runs that came due while no window was open are caught up once or skipped,
// as the schedule says, never once per run missed. A watch is a schedule that
// looks before it acts — Tade keeps where each look left off and every key
// found, so one finding never starts work twice, a start that failed included.

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

/** A schedule's id, for good, from the name it was first given: made again under it, it is changed. */
export function scheduleIdOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'schedule'
  )
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

export class Schedules {
  private readonly wire: Wiring
  private readonly deps: SchedulesDeps
  /** The schedules pass under way, if one is. */
  private pass: Promise<void> | null = null
  /** When each schedule was last run from this window, before the journal says so. */
  private readonly fired = new Map<string, number>()
  /** Watches looking now, so a slow look is never started twice. */
  private readonly lookingWith = new Map<string, Promise<string>>()

  constructor(wire: Wiring, deps: SchedulesDeps) {
    this.wire = wire
    this.deps = deps
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

  private async doRunDue(): Promise<void> {
    const live = this.wire.live
    if (!live) return
    const now = this.wire.now()
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
      const reason = why(err)
      await client.watchChecked(one.id, { problem: reason }).catch(() => {})
      const said = `${one.name} could not look: ${reason}`
      if (asked || watched.looks[0]?.problem !== reason) return say(said, true)
      return said
    }
    const { fresh, acting, left } = newFindings(looked.found, watched.seen, does.most)
    await client.watchChecked(one.id, {
      found: looked.found.length,
      fresh: fresh.map((finding) => finding.key),
      left,
      since: left > 0 ? watched.since : looked.since,
    })
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
    for (const finding of acting) {
      try {
        const agent = await looked.agent(finding).catch(async (err: unknown) => {
          // Written down as found, with why: tried again at every look, it would say so at every look.
          await client.watchFound(one.id, finding, { problem: why(err) }).catch(() => {})
          throw err
        })
        const { task } = await client.watchFound(one.id, finding, {
          agent: { ...agent, links: agent.links ?? finding.links ?? [] },
        })
        if (task) started.push(task)
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
      failed.length > 0 ? `could not start work on ${failed.join('; ')}` : '',
    ].filter(Boolean)
    return say(
      `${one.name} found ${fresh.length} new: ${parts.join('; ')}${waits}`,
      started.length === 0,
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
      if (req.most !== undefined && !(Number.isInteger(req.most) && req.most > 0)) {
        throw new Error('most is how many new things one look acts on: a whole number, 1 or more')
      }
      does = {
        kind: 'watch',
        watch: req.watch,
        input: { ...(req.input ?? {}) },
        // What the watch says it is for, unless somebody said otherwise.
        found: req.found ?? offer.offers,
        most: req.most ?? 2,
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
}
