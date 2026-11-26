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

/** What the machine said about sleeping between two moments. */
export interface SleepAnswer {
  /** True slept, false stayed awake, null could not be told. */
  slept: boolean | null
  /** Why it could not be told, when it could not. */
  trouble: string | null
}

/** Whether the machine slept between `from` and `to`, clock milliseconds. Never throws. */
export type SleptBetween = (from: number, to: number) => Promise<SleepAnswer>

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

/** This machine's answer: the kernel's on macOS, and `null` with why everywhere else. */
export const sleptBetween: SleptBetween = async (from) => {
  if (process.platform !== 'darwin') {
    return {
      slept: null,
      trouble: `${process.platform} is not asked when it slept, only macOS is`,
    }
  }
  const asked = await runProgram('sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], {
    timeoutMs: ASK_MS,
  })
  if (asked.missing) return { slept: null, trouble: 'there is no sysctl on this machine' }
  if (asked.timedOut) return { slept: null, trouble: `sysctl did not answer in ${ASK_MS} ms` }
  if (asked.code !== 0) {
    return { slept: null, trouble: `sysctl failed: ${asked.stderr.trim() || `exit ${asked.code}`}` }
  }
  return sleptSince(from, asked.stdout)
}
