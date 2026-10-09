import type { Config, Schedule } from '@tade/core'
import type { ExtensionHost, Finding } from '@tade/extensions-core'
import { intakeGrant, sayBackAbout, type Workbench } from '@tade/workbench'
import { why } from './context.ts'

// Telling a source its request was taken in.
//
// **Three gates, and none of them is here.** What may be said is a fixed set of
// sentences Tade wrote; whether anything may be said at all is the owner's
// `reply` grant, which is a second act and off by default; and how often is a
// cap per request. All of that is `sayBackAbout`'s, in the workbench, because it
// is the same question wherever it is asked from.
//
// What is here is the transport and the clock: the watch's own `reply`, absent
// on one with no path back to where its findings came from — and then nothing
// is posted and nothing is pretended.

/** Why nothing was said back, where that is worth saying; null when all is well. */
export async function sayBackFor(deps: {
  client: Workbench
  config: Config
  host: ExtensionHost | null
  now: number
  schedule: Schedule
  /** The watch, as `<extension>.<id>`. */
  watch: string
  finding: Finding
  task: string | null
}): Promise<string | null> {
  const candidate = deps.finding.intake
  if (!candidate || !deps.host) return null
  const host = deps.host
  const project = deps.schedule.project
  const mode = intakeGrant(deps.config, candidate.source).mode
  const answer = await sayBackAbout(deps.client, {
    source: candidate.source,
    candidate,
    // Acceptance is not execution: `propose` makes a task a person has to pick
    // up, so what the source is told is that it is waiting for one.
    saying: mode === 'queue' ? 'accepted' : 'proposed',
    task: deps.task,
    now: deps.now,
    post: (request) => host.reply(deps.watch, { project, input: {}, ...request }).then(() => {}),
  }).catch((err: unknown) => ({ said: null, because: why(err) }))
  if (answer.said || !answer.because) return null
  // A grant that is off is the ordinary case and not worth a word. Anything
  // else is a status nobody at the source ever saw, and a quiet failure is the
  // worst one a watch can have.
  return / is off:|already been said/.test(answer.because) ? null : answer.because
}
