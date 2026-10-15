import type { Wrote } from '@tade/core'
import type { RunId, WorkerSignal } from '@tade/harnesses-core'

// What each agent has been doing lately, as the window watched it happen: the
// last tools it ran, how its last turns ended, and which files it wrote.
//
// Kept in memory and nowhere else, like a lane's screen: it is a reading, and
// a stale one is worse than none. The journal holds what was *decided* about a
// tool call; what an agent did inside a turn is the shape of the turn, and
// writing every step of it down would be the log becoming the transcript.

/** One tool call an agent made. */
export interface Doing {
  at: number
  tool: string
  /** What it was about, short and the same every time it is the same call. */
  about: string
  /** Whether it worked; null while it is still running. */
  ok: boolean | null
}

/** How a turn ended, as its harness said. */
export interface TurnEnd {
  at: number
  status: 'ok' | 'error' | 'aborted'
}

/** How much of one agent's recent doing is kept: enough to see a loop in it. */
const KEPT_DOING = 40
const KEPT_TURNS = 12
/** How many files one task's writes are remembered for, the oldest written going first. */
const KEPT_WRITES = 512

export class Doings {
  /**
   * By run: the last things each agent did, and how its last turns ended.
   * Bounded, because a window is open for days and an agent that is fine is
   * the ordinary case: what is kept is what a loop would show up in.
   */
  private readonly doing = new Map<string, { did: Doing[]; ends: TurnEnd[] }>()
  /** Calls still running, so an answer can find what it answers and what it wrote. */
  private readonly calls = new Map<string, { did: Doing; task: string; writes: string[] }>()
  /**
   * By task, not by run: the files its harness said a call wrote, once the
   * call worked, and when. Kept past the run, because hunks an agent left
   * uncommitted are still in the checkout after it stops.
   */
  private readonly wrote = new Map<string, Map<string, number>>()

  /** What is kept about one run, made the first time it does anything. */
  of(run: string): { did: Doing[]; ends: TurnEnd[] } {
    const already = this.doing.get(run)
    if (already) return already
    const fresh = { did: [] as Doing[], ends: [] as TurnEnd[] }
    this.doing.set(run, fresh)
    return fresh
  }

  has(run: string): boolean {
    return this.doing.has(run)
  }

  called(
    run: RunId,
    task: string | null,
    signal: Extract<WorkerSignal, { type: 'tool_call' }>,
    about: string,
  ): void {
    const kept = this.of(run)
    const did: Doing = { at: signal.at, tool: signal.tool, about, ok: null }
    kept.did.push(did)
    if (kept.did.length > KEPT_DOING) kept.did.shift()
    this.calls.set(`${run}:${signal.callId}`, {
      did,
      task: task ?? '',
      writes: signal.writes ?? [],
    })
  }

  answered(run: RunId, signal: Extract<WorkerSignal, { type: 'tool_result' }>): void {
    const key = `${run}:${signal.callId}`
    const call = this.calls.get(key)
    this.calls.delete(key)
    if (!call) return
    call.did.ok = signal.ok
    // A write that failed wrote nothing anybody holds.
    if (!signal.ok || !call.task || call.writes.length === 0) return
    const files = this.wrote.get(call.task) ?? new Map<string, number>()
    for (const path of call.writes) {
      files.delete(path)
      files.set(path, signal.at)
    }
    while (files.size > KEPT_WRITES) files.delete(files.keys().next().value as string)
    this.wrote.set(call.task, files)
  }

  ended(run: RunId, end: TurnEnd): void {
    const kept = this.of(run)
    kept.ends.push(end)
    if (kept.ends.length > KEPT_TURNS) kept.ends.shift()
  }

  /** A run that is not coming back: what it was doing goes, what it wrote stays. */
  forget(run: RunId): void {
    this.doing.delete(run)
    for (const key of [...this.calls.keys()]) if (key.startsWith(`${run}:`)) this.calls.delete(key)
  }

  /** What each task's agent wrote, by task, oldest first. */
  wroteBy(): Map<string, Wrote[]> {
    const out = new Map<string, Wrote[]>()
    for (const [task, files] of this.wrote) {
      out.set(
        task,
        [...files].map(([path, at]) => ({ path, at })),
      )
    }
    return out
  }
}
