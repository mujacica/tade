import { readFileSync } from 'node:fs'
import { runProgram } from '@tade/core'

// Whether the machine really slept while a check ran.
//
// The beats (`awake.ts`) only *suspect* a sleep: a gap past `AWAY_AFTER_MS`
// between two of them. A machine so loaded that the runner's own timer fires
// ninety seconds late leaves exactly that gap with the lid open, and three
// related runs in one day were recorded `cancelled`, `the machine slept`,
// thirteen failing tests and all, while `pmset -g log` shows no sleep at any
// point in any of them. A clock jump is a reason to ask, never the answer.
//
// So the kernel is asked. macOS keeps the last time it went to sleep and the
// last time it woke (`kern.sleeptime`, `kern.waketime`, what `pmset -g log`
// prints the wakes of): a run started before either slept through it,
// dark wakes included, and one started after both did not. Where the machine
// cannot say — another platform, a `sysctl` that failed or printed something
// else — the answer is `null`, and the run keeps the state it earned: a red
// run nobody can explain is still red, said beside its tail.
//
// Linux keeps no time of its last sleep, only how long it has slept in all:
// `/proc/uptime` counts a suspend and the monotonic clock (`process.hrtime`,
// CLOCK_MONOTONIC) does not, so their difference grows by every suspend and
// by nothing else — a timer ninety seconds late with the lid open moves both
// alike. A total says nothing about when, so the runner marks it at every beat
// (`SleptBetween.mark`) and an ask compares the total now with the one marked
// at or before the moment asked from. Reading it is a file read of a few
// bytes, never a process.

/** What the machine said about sleeping between two moments. */
export interface SleepAnswer {
  /** True slept, false stayed awake, null could not be told. */
  slept: boolean | null
  /** Why it could not be told, when it could not. */
  trouble: string | null
}

/**
 * Whether the machine slept between `from` and `to`, clock milliseconds. Never
 * throws. A machine that can only answer from what it read at the moment asked
 * from has a `mark`, which the runner calls at the start and at every beat.
 */
export type SleptBetween = ((from: number, to: number) => Promise<SleepAnswer>) & {
  readonly mark?: (at: number) => void
}

/** How long `sysctl` is given: it answers in milliseconds, and nothing waits without a deadline. */
const ASK_MS = 2_000

/** The latest of `kern.sleeptime` and `kern.waketime`, in milliseconds, or null where neither reads. */
export function lastSleepOrWake(printed: string): number | null {
  const secs = [...printed.matchAll(/sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/g)].map(
    (one) => Number(one[1]) * 1_000 + Math.floor(Number(one[2]) / 1_000),
  )
  return secs.length === 0 ? null : Math.max(...secs)
}

/** The rule, apart from asking: a sleep or a wake at or after the run began is a sleep in it. */
export function sleptSince(from: number, printed: string): SleepAnswer {
  const last = lastSleepOrWake(printed)
  if (last === null) {
    return {
      slept: null,
      trouble: `sysctl printed no sleep or wake time: ${printed.trim().slice(0, 120)}`,
    }
  }
  return { slept: last >= from, trouble: null }
}

/**
 * How much the suspended total may grow and still be no sleep: `/proc/uptime`
 * reads in hundredths, and the two clocks are read a moment apart.
 */
export const SUSPEND_NOISE_MS = 250

/** A suspended total, in milliseconds, or why it could not be read. */
export type Suspended = { ms: number } | { trouble: string }

/**
 * The suspended total from what `/proc/uptime` printed and the monotonic
 * clock read either side of reading it: a read that took longer than the noise
 * cannot be placed between the two, and is no reading.
 */
export function suspendedOf(printed: string, before: number, after: number): Suspended {
  const up = /^\s*(\d+(?:\.\d+)?)\s/.exec(printed)
  if (!up) return { trouble: `/proc/uptime printed no uptime: ${printed.trim().slice(0, 120)}` }
  if (after - before > SUSPEND_NOISE_MS / 2) {
    return { trouble: `reading /proc/uptime took ${Math.round(after - before)} ms` }
  }
  // Hundredths, cut rather than rounded: the uptime is up to 10 ms past what it prints.
  return { ms: Number(up[1]) * 1_000 + 5 - (before + after) / 2 }
}

/**
 * What was marked, kept only where the total moved: between two of these it
 * read the same at every beat, so the last one at or before a moment is what
 * it read then. A failed read is kept too, so it is never answered past.
 */
export interface SleepMarks {
  mark(at: number, read: Suspended): void
  since(from: number, read: Suspended): SleepAnswer
}

/** How many moves of the total are kept: one per suspend, and a failed read. */
const MARKS_KEPT = 64

export function sleepMarks(): SleepMarks {
  const kept: { at: number; read: Suspended }[] = []
  return {
    mark(at, read) {
      const last = kept.at(-1)?.read
      const same = last && 'ms' in last && 'ms' in read && read.ms - last.ms <= SUSPEND_NOISE_MS
      if (same) return
      kept.push({ at, read })
      if (kept.length > MARKS_KEPT) kept.shift()
    },
    since(from, read) {
      const then = kept.findLast((one) => one.at <= from)?.read
      if (!then)
        return { slept: null, trouble: 'the suspended time was not read when the run began' }
      if ('trouble' in then) return { slept: null, trouble: then.trouble }
      if ('trouble' in read) return { slept: null, trouble: read.trouble }
      return { slept: read.ms - then.ms > SUSPEND_NOISE_MS, trouble: null }
    },
  }
}

/** Milliseconds on the monotonic clock, which stops while Linux is suspended. */
const monotonic = () => Number(process.hrtime.bigint()) / 1e6

/** This Linux machine's suspended total now, read from `file` (`/proc/uptime`). Never throws. */
export function readSuspended(file = '/proc/uptime'): Suspended {
  const before = monotonic()
  let printed: string
  try {
    printed = readFileSync(file, 'utf8')
  } catch (error) {
    return { trouble: `/proc/uptime could not be read: ${(error as Error).message}` }
  }
  return suspendedOf(printed, before, monotonic())
}

/** Linux's answer, from the suspended total `read` gives, marked at the beats. */
export function suspendedSlept(read: () => Suspended = readSuspended): SleptBetween {
  const marks = sleepMarks()
  return Object.assign(async (from: number) => marks.since(from, read()), {
    mark: (at: number) => marks.mark(at, read()),
  })
}

/**
 * macOS's answer, from the kernel's last sleep and wake as `program` (`sysctl`)
 * prints them, and `null` with why on any `platform` but macOS.
 */
export function kernelSlept(platform: NodeJS.Platform, program = 'sysctl'): SleptBetween {
  return async (from: number): Promise<SleepAnswer> => {
    if (platform !== 'darwin') {
      return {
        slept: null,
        trouble: `${platform} is not asked when it slept, only macOS and Linux are`,
      }
    }
    const asked = await runProgram(program, ['-n', 'kern.sleeptime', 'kern.waketime'], {
      timeoutMs: ASK_MS,
    })
    if (asked.missing) return { slept: null, trouble: 'there is no sysctl on this machine' }
    if (asked.timedOut) return { slept: null, trouble: `sysctl did not answer in ${ASK_MS} ms` }
    if (asked.code !== 0) {
      return {
        slept: null,
        trouble: `sysctl failed: ${asked.stderr.trim() || `exit ${asked.code}`}`,
      }
    }
    return sleptSince(from, asked.stdout)
  }
}

/** This machine's answer: the kernel's on macOS and Linux, and `null` with why everywhere else. */
export const sleptBetween: SleptBetween =
  process.platform === 'linux' ? suspendedSlept() : kernelSlept(process.platform)
