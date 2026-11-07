import { closeWaitsOn, closeWhenDoneFor, type TadeEvent } from '@tade/core'
import { eventNews, eventTell } from '../inbox.ts'
import { withTranscript } from '../model.ts'
import { problem, tadeDid } from '../transcript.ts'
import { type Wiring, why } from './context.ts'
import type { Tellable } from './handed.ts'

// A finished agent's lane, closed by itself where `close_when_done` says.
//
// The rule is core's (`close-when-done.ts`); this is the window keeping to the order it
// asks for. What an agent left is already parked by the time it is finished:
// `tade_done` sends its leftovers first and is refused if they were not taken,
// and a `leftovers_reported` line is only written once its work is parked. What
// it reported goes to the orchestrator at once rather than waiting as news,
// because "goes with the next thing you say" can be tomorrow and the lane is to
// go today, and the close waits for that to be accepted: a report that could not
// be told keeps the lane open and is said, and tried again.
//
// Only the lane goes. `stopAgent` leaves the task, its branch or worktree, its
// conversation and its documents, and takes the `lost` mark off the lane, so the
// next window has nothing to bring back and a press of Open carries on.

/** How long before something that failed here is tried again, and how long nobody to tell goes unsaid. */
export const CLOSE_RETRY_MS = 60_000

export interface CloseWhenDoneDeps {
  orchestrator: Tellable
  /** End the agent's lane and nothing else. */
  close(task: string): Promise<void>
  /** Whether a person has this agent in front of them. */
  looking(task: string): boolean
}

const laneOf = (task: string) => `${task}/agent` as never

export class CloseWhenDone {
  private readonly wire: Wiring
  private readonly deps: CloseWhenDoneDeps
  /** The `task_done` lines the orchestrator has, by number: a task may finish twice. */
  private readonly told = new Set<number>()
  private readonly telling = new Set<number>()
  /** Reports only this has, because `heard` took them: told or noted, never let go of. */
  private readonly held = new Map<string, TadeEvent>()
  /** What failed, or has nobody to tell, and when it is next looked at. */
  private readonly notBefore = new Map<string, number>()
  /** What has been said on screen, so a beat that finds it again says nothing. */
  private readonly said = new Set<string>()
  /** One pass at a time: a close takes longer than a beat. */
  private passing = false

  constructor(wire: Wiring, deps: CloseWhenDoneDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** Whether this task's agent is owed closing, whatever state its lane is in. */
  owes(task: string): boolean {
    return Boolean(this.wire.live?.closesOwed.get(task)?.done) && this.on(task)
  }

  /**
   * A line of the journal: true where it is a report this has taken on, so it
   * goes to the orchestrator from here and nowhere else — said twice otherwise,
   * once now and once with the next thing somebody says.
   */
  heard(event: TadeEvent): boolean {
    if (event.type !== 'task_done' || !event.task || !this.closes(event.task)) return false
    this.held.set(event.task, event)
    void this.report(event.task, event)
    return true
  }

  /** Look at everything owed closing and close what nothing is holding open. */
  async beat(): Promise<void> {
    if (this.passing) return
    this.passing = true
    try {
      await this.pass()
    } catch (err) {
      this.wire.note(err)
    } finally {
      this.passing = false
    }
  }

  private async pass(): Promise<void> {
    const live = this.wire.live
    if (!live) return
    this.letGo()
    const client = this.wire.opts.client
    const closed: string[] = []
    for (const [task, facts] of live.closesOwed) {
      if (!facts.done || !this.closes(task)) continue
      void this.report(task, facts.done)
      const waits = closeWaitsOn(facts, {
        now: this.wire.now(),
        turn: client.turnOf(`${task}/agent`),
        approval: client.pendingApprovals(task).length > 0,
        lost: client.lane(laneOf(task))?.lost === true,
        told: this.told.has(facts.done.seq),
        looking: this.deps.looking(task),
      })
      if (waits || !this.due(`close:${task}`)) continue
      if (await this.close(task, facts.done)) closed.push(task)
    }
    if (closed.length === 0) return
    await live.refresh()
    const line = `Closed the agent on ${closed.join(', ')}: finished, and its work all stays.`
    this.wire.put(
      withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, line, this.wire.now())),
    )
    this.wire.draw()
  }

  private async close(task: string, done: TadeEvent): Promise<boolean> {
    const client = this.wire.opts.client
    const lost = client.lane(laneOf(task))?.lost === true
    try {
      await this.deps.close(task)
    } catch (err) {
      this.failed(
        `close:${task}`,
        `Could not close the agent on ${task}: ${why(err)}. It stays open, and is tried again.`,
      )
      await client.log
        .append({
          type: 'warning',
          task,
          detail: { message: `could not close its agent: ${why(err)}` },
        })
        .catch((failed: unknown) => this.wire.note(failed))
      return false
    }
    this.notBefore.delete(`close:${task}`)
    this.said.delete(`close:${task}`)
    // After it happened: a line for a close that then failed is worse than none.
    const own = this.wire.opts.config.projects[projectOf(task)]?.close_when_done
    await client.log
      .append({
        type: 'agent_closed',
        task,
        detail: {
          done_by: String(done.detail.by ?? 'unknown'),
          setting: own ? `projects.${projectOf(task)}.close_when_done` : 'agents.close_when_done',
          lost,
        },
      })
      .catch((err: unknown) => this.wire.note(err))
    return true
  }

  /** Put what a task reported in the orchestrator's hands, once. */
  private async report(task: string, done: TadeEvent): Promise<void> {
    if (this.told.has(done.seq) || this.telling.has(done.seq)) return
    const key = `told:${task}`
    const orchestrator = this.deps.orchestrator
    if (!orchestrator.started) {
      // It is usually on its way, so this is only said once it has not come.
      if (!this.notBefore.has(key)) this.notBefore.set(key, this.wire.now() + CLOSE_RETRY_MS)
      else if (this.due(key)) {
        this.say(
          key,
          `${task} finished, and its agent stays open until the orchestrator can be told.`,
        )
      }
      return
    }
    if (!this.due(key)) return
    this.telling.add(done.seq)
    try {
      await orchestrator.tell(reportOf(this.wire, done))
      this.told.add(done.seq)
      this.held.delete(task)
      this.notBefore.delete(key)
      this.said.delete(key)
    } catch (err) {
      this.failed(
        key,
        `Could not tell the orchestrator ${task} finished (${why(err)}), so its agent stays open, and it is tried again.`,
      )
    } finally {
      this.telling.delete(done.seq)
    }
  }

  /**
   * A report this took on for a close that is no longer coming — the setting
   * went off, or the lane went some other way — goes the way it would have gone,
   * with the next thing somebody says, rather than nowhere.
   */
  private letGo(): void {
    for (const [task, done] of this.held) {
      if (this.closes(task) || this.telling.has(done.seq)) continue
      this.held.delete(task)
      this.deps.orchestrator.note(eventNews(done) ?? `${task} finished`)
    }
  }

  private on(task: string): boolean {
    return closeWhenDoneFor(this.wire.opts.config, projectOf(task))
  }

  /** Whether the setting says so and there is a lane to close: one running, or one the window lost. */
  private closes(task: string): boolean {
    if (!this.on(task)) return false
    const lane = this.wire.opts.client.lane(laneOf(task))
    return lane?.alive === true || lane?.lost === true
  }

  private due(key: string): boolean {
    return (this.notBefore.get(key) ?? 0) <= this.wire.now()
  }

  private failed(key: string, line: string): void {
    this.notBefore.set(key, this.wire.now() + CLOSE_RETRY_MS)
    this.say(key, line)
  }

  /** Said once until it clears: nothing goes wrong silently, and nothing every two seconds. */
  private say(key: string, line: string): void {
    if (this.said.has(key)) return
    this.said.add(key)
    this.wire.put(
      withTranscript(this.wire.state, problem(this.wire.state.transcript, line, this.wire.now())),
    )
    this.wire.draw()
  }
}

const projectOf = (task: string) => task.split('/')[0] ?? task

/** What a task reported, as the orchestrator is told it: with its document, where it has one. */
function reportOf(wire: Wiring, done: TadeEvent): string {
  const events = wire.live?.queueFacts().events ?? []
  return eventTell(done, events) ?? eventNews(done) ?? `${String(done.task)} finished`
}
