import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type IntakeCandidate,
  intakeKey,
  intakePrompt,
  intakeSpool,
  intakeTitle,
  newerRevision,
} from '@tade/core'
import type { TadeExtension } from '@tade/extensions-core'
import { candidateOf, newestOf, readSpool, type SpoolEntry } from './spool.ts'

// The local intake door: work that somebody at this machine handed to Tade as
// if it had come from a tracker.
//
// **One watch, and it is an ordinary watch.** It looks at a folder on a clock,
// it finds requests, and what happens to each of them is the grant, the rule,
// the queue and the approval that every other source will go through. There is
// no second scheduler here and no second way into the queue — which is the
// whole claim intake makes, and this is the cheapest possible way to hold it to
// that claim: if the local door needed anything the pipeline does not have, the
// pipeline is wrong.
//
// **What it is for.** Three things, honestly:
//
// 1. The inbox, the approval, the parked proposal, the re-check at the start and
//    the reply can all be *used* before any connector exists — which is how
//    somebody finds out whether this surface is worth having at all.
// 2. Every rule above it is testable with no credential and no network, which
//    is the difference between a test suite and a mock of GitHub.
// 3. `tade intake` is a real way to queue a request against a project from a
//    script, with the owner's own grant deciding whether it may.
//
// **What it is not.** It is not a listener and it is not an API: nothing binds
// a port, nothing answers a request from off this machine, and a file in the
// spool got there because somebody with an account on this machine wrote it. The
// grant still decides, because a door that trusted whoever could write a file
// would be a door with no rule behind it.
//
// Nothing here reaches the network, so the watch does not declare `network` and
// keeps looking with the wifi off.

/** Where a reply this door posted is written down: the one thing it can "send". */
export const REPLIES = 'replies.jsonl'

/** The newest revision of each request this project has in the spool. */
async function requests(
  home: string,
  project: string,
): Promise<{ newest: Map<string, SpoolEntry & { file: string }>; broken: string[] }> {
  const read = await readSpool(home)
  const mine = read.entries.filter((entry) => entry.project === project)
  return {
    newest: newestOf(mine),
    broken: read.broken.map((one) => `${one.file} (${one.problem})`),
  }
}

export const intakeExtension: TadeExtension = {
  name: 'intake',
  title: 'Intake',
  description:
    'Work that arrives from outside this machine. The local door takes a request written here and puts it through the same grant, rule, queue and approval every connector will go through.',
  workflow: [
    'A person writes a request with `tade intake`, naming the project and who asked.',
    'The `intake.cli` watch finds it on its next look, and the owner’s own grant decides whether it may become work (surfaces.intake).',
    'With `mode: propose`, which is the default, a task is made and parked: a person approves it and the queue starts it.',
    'At the moment of starting, the request is checked again — withdrawn or rewritten holds the work rather than starting it.',
    'Nothing is posted anywhere unless `reply` is on for that source, and then only sentences Tade generated.',
  ],
  // Nothing to set up: no key, no endpoint, no account. Being ready is having a
  // home to read, which every window has — so there is nothing it needs, which
  // is what `null` says, and it asks nothing of the world to find that out.
  ready: () => null,
  watches: [
    {
      id: 'cli',
      title: 'Requests written at this machine',
      means:
        'takes in each request in Tade’s intake spool that is for this project, as far as the grant in surfaces.intake allows it',
      every: '5m',
      // It declares what it is, so every rule about grants, modes, revisions
      // and re-checks can be asked of it before it has looked at anything.
      intake: 'cli',
      check: async (ctx) => {
        const seenAt = new Date(ctx.now()).toISOString()
        const { newest, broken } = await requests(ctx.home, ctx.watching.name)
        const found = [...newest.values()]
          // A withdrawal is not a request: the newest revision saying the thing
          // is over means there is nothing to start, and work already made is
          // held by the re-check rather than by a finding.
          .filter((entry) => !entry.closed)
          .map((entry) => {
            const candidate = candidateOf(entry, seenAt)
            return {
              key: intakeKey(candidate),
              title: intakeTitle(candidate),
              intake: candidate,
            }
          })
        return {
          found,
          ...(found.length === 0
            ? {
                said:
                  broken.length > 0
                    ? `nothing in the intake spool for this project, and ${broken.length} file${broken.length === 1 ? '' : 's'} there could not be read: ${broken.join('; ')}`
                    : 'nothing in the intake spool for this project',
              }
            : {}),
        }
      },
      agent: (finding) => {
        const candidate = finding.intake as IntakeCandidate
        // Tade's own words, both of them, and neither can reach the body: it is
        // not in the type either of them takes. What the task is *called* and
        // what its `intent_spoken` says are the intake path's own
        // (`intakeSuffix`, `intakeSummary`), because only there is the project
        // and the grant that allowed it actually known.
        return { title: intakeTitle(candidate), prompt: intakePrompt(candidate) }
      },
      recheck: async (finding, ctx) => {
        // The key carries the revision the work was made for, so this answers
        // the question the queue is actually asking: is the thing still what it
        // was when somebody approved it?
        const [, id, revision] = finding.key.split(':')
        if (!id || !revision)
          return { still: false, because: `${finding.key} is not a request this door wrote` }
        const { newest } = await requests(ctx.home, ctx.watching.name)
        const entry = newest.get(id)
        if (!entry) {
          // Gone from the spool entirely — somebody removed the file. Nothing
          // was verified, so nothing stands: an unverifiable request holds.
          return { still: false, because: `${id} is no longer in the intake spool` }
        }
        if (entry.closed) {
          return { still: false, because: `${id} was withdrawn at revision ${entry.revision}` }
        }
        const order = newerRevision('cli', String(entry.revision), revision)
        if (order === null) {
          return {
            still: false,
            because: `${id}'s revisions cannot be ordered: somebody has to say`,
          }
        }
        if (order > 0) {
          return {
            still: false,
            because: `${id} is now revision ${entry.revision}, and the work was made for revision ${revision}`,
          }
        }
        return { still: true }
      },
      reply: async (request, ctx) => {
        // The one thing this door can "send": a line in a file beside the
        // spool. It is the whole of what a connector's `reply` is for — the
        // transport — and it chooses nothing about what is said.
        const dir = intakeSpool(ctx.home)
        await mkdir(dir, { recursive: true })
        await appendFile(
          join(dir, REPLIES),
          `${JSON.stringify({ at: new Date(ctx.now()).toISOString(), key: request.key, said: request.say })}\n`,
          { mode: 0o600 },
        )
      },
    },
  ],
}
