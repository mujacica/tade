import {
  type Config,
  INTAKE_REPLY_ATTEMPTS,
  type InboxRow,
  type IntakeItem,
  outboxFor,
  type Schedule,
} from '@tade/core'
import type { ExtensionHost } from '@tade/extensions-core'
import { intakeGrant, intakeSourceOf, sayBackAbout, type Workbench } from '@tade/workbench'
import { why } from './context.ts'

// Telling a source where its request got to.
//
// **One place posts, and it is driven by a fold.** The inbox refolds when a
// line it depends on is written — a request accepted, an agent started, a task
// done, a park put back — and each refold asks the outbox what is due. So the
// moment a status becomes true is the moment it goes, there is no second clock,
// and nothing is remembered: `outboxFor` reads the journal's own record of
// what has already gone, which is what makes dedupe survive a restart.
//
// **Every gate is somewhere else, deliberately.** What may be said is a fixed
// set of sentences in `@tade/core`; whether anything may be said at all, and
// whether it may name the work, is the owner's grant; how often is two bounds
// and a cap; and the door that writes it down is the workbench's. What is here
// is the transport and the window: the extension host, so a watch's own
// `reply` can be reached, and the sentences a person sees when a status could
// not go out.
//
// **A status can never stop work.** A reply that fails is written down and
// said, the request carries on being built, and nothing here is ever asked
// before a start. That is why the drain is in the inbox's fold rather than in
// the queue's advance.

/** What a drain needs: the journal's doors, the rows it folded, and the host. */
export interface SayDue {
  client: Workbench
  config: Config
  host: ExtensionHost | null
  now: number
  rows: readonly InboxRow[]
  items: ReadonlyMap<string, IntakeItem>
  /** The schedules, for the input each watch was turned on with. */
  schedules: readonly Schedule[]
  machine: string
}

/**
 * Post whatever status is due about each request, and say what could not go.
 *
 * Returns one sentence per status nobody at a source ever saw, which the
 * window puts in the transcript — **a reply that quietly failed is the worst
 * failure this path has**, because the person who asked is left watching an
 * issue that never said anything. A grant that is off, a cap, a status already
 * said and a saying whose moment passed are all silent: they are the rule
 * working, and a line every refold about a capability nobody turned on is
 * noise that teaches people to ignore lines.
 */
export async function sayDue(deps: SayDue): Promise<string[]> {
  const host = deps.host
  if (!host) return []
  const quiet: string[] = []
  for (const row of deps.rows) {
    // A row from a source this Tade does not implement any more: there is
    // nothing to post with and nothing to say about it here, because the row
    // itself is still in the inbox saying where its work got to.
    const source = intakeSourceOf(row.source)
    if (!source) continue
    const item = deps.items.get(row.item)
    // The grant as the config says it *now*, at the moment of posting: a
    // person who turned replies off a minute ago turned them off for this.
    const grant = intakeGrant(deps.config, source)
    const standing = outboxFor({ row, item, grant, now: deps.now, machine: deps.machine })
    if (standing.outbox !== 'due') continue
    const entry = standing.entry
    // Which watch found it, and what it was turned on with. A watch that is
    // gone — the extension off, the schedule removed — has no transport, and
    // that is not a failure to shout about: there is nothing to post with.
    if (!row.watch) continue
    const schedule = deps.schedules.find((one) => one.id === row.schedule)
    const input = schedule?.does.kind === 'watch' ? schedule.does.input : {}
    try {
      await sayBackAbout(deps.client, {
        source,
        candidate: {
          externalId: row.externalId,
          // The revision the work was made for, so the transport finds the
          // same thing the queue did rather than whatever is newest.
          revision: row.taken || row.revision,
          correlation: item?.correlation ?? row.item,
        },
        saying: entry.saying,
        task: row.tasks[0] ?? null,
        now: deps.now,
        // The transport, and only the transport: the key, the sentence and the
        // marker, every one of them the door's own. There is nothing else it
        // can be asked for.
        post: (request) => host.reply(row.watch, { project: row.project, input, ...request }),
      })
    } catch (err) {
      // Which try it was, because "it failed again" and "it failed once" are
      // different news: the third one is the last, and somebody reading this
      // wants to know whether anything else will be attempted.
      quiet.push(
        `could not say ${entry.saying} back about ${row.externalId} (try ${entry.attempt} of ${INTAKE_REPLY_ATTEMPTS}): ${why(err)}`,
      )
    }
  }
  return quiet
}
