import { type Config, type LivenessTable, livenessOf, type Workspace } from '@tade/core'
import { newTranscriptReads, type TranscriptReads } from './adoption.ts'
import { newProbeGate, type ProbeGate } from './gate.ts'
import { gitLoad } from './git.ts'
import { lookAtStatus, type StatusOptions } from './status.ts'

// How a window looks at status: the port, and the look done in the window's
// own process. Both are reached through `COLLECTORS` (`collectors.ts`).
//
// The window looks every two seconds for as long as it is open, and a look is
// a fork storm — `ps`, then three or four `git`s a worktree — plus porcelain
// parsing, task files and transcripts, all of it garbage on the heap of the
// thread that draws. A collector is what lets that happen somewhere else
// (`lookInChild`) while the window only waits on a promise with a deadline.
// `lookHere` is the same look in-process: what tests, and anything that is not
// a window, are given.
//
// Everything in an ask is plain data, because one of the two implementations
// sends it down a pipe: the lanes in particular are the window's, so it reads
// them first (`livenessTableFrom`) and sends the answers rather than the probe.

/** A look at status, asked for in plain data. */
export interface StatusAsk {
  config: Config
  now: number
  /** $HOME, where provider transcripts live. */
  home: string
  /** Tade's own home, where every task's file is. */
  tadeHome: string
  cwd?: string | undefined
  /** Query `gh` for PR state (network). */
  pr: boolean
  /** The window's own lanes and runs, read just before the look. */
  lanes: LivenessTable
}

/** What one look cost the process that made it. */
export interface Spent {
  /** git processes it started. */
  spawns: number
  /** That process's resident bytes, once it had looked. */
  rss: number
  /** Which process looked: the window's own, or the child it holds. */
  pid: number
}

/**
 * What a look came to: a workspace, or `unknown` and why.
 *
 * Never a third thing, and never an empty workspace standing in for the
 * second — a look that could not be had is not a world with nothing in it,
 * which everything above would read as "nothing is running". Whoever asked
 * keeps the last look that could, which is the rule every probe already has.
 */
export type StatusAnswer =
  | { known: true; workspace: Workspace; spent: Spent }
  | { known: false; why: string }

export interface StatusCollector {
  /** Its name in `COLLECTORS`. */
  readonly id: string
  /** Never throws, and never waits without a deadline. */
  collect(ask: StatusAsk): Promise<StatusAnswer>
  /** Let go of whatever it holds. Safe twice; a look after it is `unknown`. */
  close(): Promise<void>
}

/** What a look after `close()` is answered with. */
export const CLOSED = 'status is no longer being looked at: the window that asked has closed'

/** What whoever polls holds between looks: the gate, and what was read of each transcript. */
export interface Held {
  gate: ProbeGate
  transcripts: TranscriptReads
}

/** The options a look is asked with here, out of an ask and what will answer it. */
export function optionsOf(ask: StatusAsk, held: Held): StatusOptions {
  const { lanes, cwd, ...rest } = ask
  return { ...rest, ...(cwd ? { cwd } : {}), ...held, liveness: livenessOf(lanes) }
}

/**
 * The look in this process, with a gate and transcript reads of its own for as
 * long as it is held: both belong to whoever polls.
 *
 * In a window this puts the whole look on the drawing thread, which is why the
 * window is given `child` instead. It is also what the child runs, so the two
 * are the same look by construction rather than by two copies agreeing.
 */
export function lookHere(): StatusCollector {
  const held: Held = { gate: newProbeGate(), transcripts: newTranscriptReads() }
  let closed = false
  return {
    id: 'here',
    async collect(ask) {
      if (closed) return { known: false, why: CLOSED }
      const before = gitLoad().started
      try {
        const workspace = await lookAtStatus(optionsOf(ask, held))
        return {
          known: true,
          workspace,
          spent: {
            spawns: gitLoad().started - before,
            rss: process.memoryUsage.rss(),
            pid: process.pid,
          },
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        return { known: false, why: `status: unexpected error: ${why.split('\n')[0]}` }
      }
    },
    async close() {
      closed = true
    },
  }
}
