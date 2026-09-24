import { watchedFrom } from '@tade/core'
import type { ExtensionContext } from '@tade/extensions-core'
import { readJournal } from '@tade/workbench/events'

// What the review watches have found, read straight out of the journal.
//
// Tade keeps where each look left off and every key it found (`watch_found`),
// so a watch keeps nothing of its own and one finding never starts work twice
// — a start that failed included, which is why a finding with a `problem` on
// it still counts as found. This is the one reader of that, for the tool that
// lists it, the page that draws it, and the two watches that ask how many
// automatic attempts something has already had.

export interface Found {
  at: string
  key: string
  title: string
  /** The task it started, when it started one. */
  task: string | null
  /** Told to the orchestrator rather than started on. */
  told: boolean
  /** Why nothing could be started on it. */
  problem: string | null
}

/** What the review watches found, oldest first. No network: the journal answers with Tade closed. */
export async function found(ctx: ExtensionContext): Promise<Found[]> {
  const events = await readJournal(ctx.home, { types: ['watch_found', 'watch_checked'] }).catch(
    () => [],
  )
  const { readSchedules } = await import('@tade/workbench/schedules')
  let ids: string[] = []
  try {
    ids = readSchedules(ctx.home)
      .filter(
        (schedule) =>
          schedule.does.kind === 'watch' && schedule.does.watch.startsWith(`${ctx.extension}.`),
      )
      .map((schedule) => schedule.id)
  } catch {
    // No schedules file is the normal case, not an error.
  }
  return ids.flatMap((id) =>
    watchedFrom(events, id).findings.map((finding) => ({
      at: new Date(finding.at).toISOString(),
      key: finding.key,
      title: finding.title,
      task: finding.task,
      told: finding.told !== null,
      problem: finding.problem,
    })),
  )
}

/**
 * How many automatic fixes have already been started on one thing, from the
 * journal: every finding whose key begins with its prefix and that put an
 * agent to work. Past the `attempts` setting, a watch stops fixing and only
 * says what is wrong — the same rule everywhere, so a failure nothing can fix
 * cannot be worked at all night.
 *
 * `since` is what keeps that from becoming permanent. A branch is watched for
 * as long as the project exists, so counting every attempt ever made on it
 * would stop the watch fixing anything again, forever, because of a bad
 * afternoon last spring. Counted over a window, a loop is still caught and
 * tomorrow still starts clean.
 */
export async function attemptsUnder(
  ctx: ExtensionContext,
  prefix: string,
  since = 0,
): Promise<number> {
  const record = await found(ctx)
  return record.filter(
    (one) => one.key.startsWith(prefix) && one.task !== null && Date.parse(one.at) >= since,
  ).length
}
