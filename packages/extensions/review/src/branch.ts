import { checkLine } from '@tade/checks-core'
import {
  type ExtensionWatch,
  type Finding,
  Unreachable,
  type WatchAgent,
} from '@tade/extensions-core'
import { type CommitCi, cannotLook, ciOn, saidOf, standingOn } from './commit.ts'
import { settingsOf, whereOf } from './forge.ts'
import { attemptsUnder } from './record.ts'

// CI on the branch you are actually on, which is the half of CI that has no
// review to hang off.
//
// `review.checks-failed` reads what the forge says about the reviews you
// opened. A project whose work goes straight to its base branch opens none,
// so nothing was watching the run that decides whether the branch everybody
// else pulls is broken — every red build was carried to the orchestrator by
// hand. This is that run, watched.
//
// Four things keep it honest:
//
//   · **It asks git before it asks anybody else.** What CI said about the
//     commit this checkout is on is `ciOn` (`commit.ts`), which answers from
//     the refs here before it spends a request, and hands back a forge only
//     with the one answer there is something to do about. A commit that is not
//     on the remote is not a failure: it is CI that has not run yet.
//   · **The commit is the unit, and one red commit is one finding.** A
//     failure is a fact about a commit, not about a branch that has moved on,
//     so the key is the commit and nothing else: a workflow re-run is the same
//     key and starts nothing new, and a fix pushed on top is a new commit,
//     which is new information and is looked at again. One finding per
//     *check* would be three agents editing one repository over one push,
//     which in a shared checkout is worse than the failure — so the agent is
//     told about every check that failed, with each of their logs, and fixes
//     the commit rather than a column of a table.
//   · **A branch with a review is the review watch's.** That call is made
//     only once something is red, so the ordinary look — green, or nothing
//     run yet — costs one request and no agent ever gets started twice on one
//     failure.
//   · **It only ever adds work.** It never pushes, never reverts, never
//     merges, and past `attempts` fixes on one branch it stops fixing and
//     says what is wrong instead.

/** How far back an attempt still counts against the next one: a night's loop, not last week's. */
const FIXING_HOURS = 6
const FIXING_WINDOW_MS = FIXING_HOURS * 60 * 60_000

/** The repository and the commit a finding of this watch is about. */
export function readKey(key: string): { repo: string; commit: string } | null {
  const match = /^[^/]*\/(.+)@(.+)$/.exec(key)
  return match?.[1] && match[2] ? { repo: match[1], commit: match[2] } : null
}

/** How many failing checks an agent is handed the log of. Past this they are named and no more. */
const LOGS = 3

export const branchChecks: ExtensionWatch = {
  id: 'branch-checks',
  title: 'Failing CI on the branch you are on',
  means:
    'watches what CI says about the commit the project’s branch is on — a push straight to main included — and puts one agent on each commit it finds red',
  every: '10m',
  // It asks a forge, so an offline machine holds it rather than letting it
  // find that out with a request that times out once every ten minutes.
  network: true,
  // On without anybody turning it on: it reads one commit's checks with the
  // credential the extension already has, tells nobody anything, and a look
  // that finds nothing costs one request — none at all where the commit is not
  // pushed, which git answers for free. With no credential the extension is not
  // ready, so there is no schedule at all rather than one failing all day.
  standing: true,

  async check(ctx) {
    const since = new Date(ctx.now()).toISOString()
    const here = await standingOn(ctx, ctx.watching.root)
    if (!here) return { found: [], since }
    const ci = await ciOn(ctx, ctx.watching, here)
    if (ci.kind !== 'red') return quietly(ci, since)
    const { where, runs: red } = ci
    // Worth a second call only now that something is red. A branch that has a
    // review open is that review's: `review.checks-failed` answers its
    // failures, and two watches on one failure would start two agents on it.
    if (await where.forge.reviewOf(where.repo, here.branch)) return { found: [], since }
    const host = where.host
    const names = red.map((run) => run.check)
    const found: Finding = {
      // The commit is in the key and the branch is not, and no check is: a
      // re-run of the same commit is the same failure, a fix pushed on top is
      // a new one, and one push never becomes one agent per failing check.
      key: `${host}/${where.repo}@${here.commit}`,
      title: `${said(names)} failing on ${here.branch} — ${here.subject}`,
      detail: [
        `${where.repo} \`${here.branch}\` is at \`${here.commit.slice(0, 12)}\` — ${here.subject}`,
        '',
        ...red.map(checkLine),
      ].join('\n'),
      links: red.flatMap((run) =>
        run.where.kind === 'forge' && run.where.url
          ? [{ title: `${run.check} on ${where.repo}`, url: run.where.url }]
          : [],
      ),
    }
    return { found: [found], since }
  },

  async agent(finding, ctx): Promise<WatchAgent> {
    const settings = settingsOf(ctx)
    const where = await whereOf(ctx, ctx.watching)
    const part = readKey(finding.key)
    // Counted across commits: a fix that is pushed and fails again is a new
    // key, so counting one key's own attempts would only ever answer one.
    const spent =
      part === null
        ? 0
        : await attemptsUnder(
            ctx,
            finding.key.slice(0, finding.key.indexOf('@') + 1),
            ctx.now() - FIXING_WINDOW_MS,
          )
    // Two ways to end up only reporting, and they are said differently
    // because they mean different things: the settings never asked for
    // automatic fixes, or this branch has had its attempts and is still red.
    const enough = spent >= settings.attempts
    const fixing = settings.fix.includes('checks') && !enough
    // Asked again rather than carried on the finding, because a log is slow
    // and `agent` is only ever asked for what work is actually started on.
    // Not through `ciOn`: this commit is on the remote or there would be no
    // finding, and `whatRan` waits for a commit to settle — a workflow somebody
    // re-ran since would empty the context of the very failure this finding is
    // about.
    const about = 'problem' in where || !part ? null : { forge: where.forge, ...part }
    const failed = !about
      ? []
      : await about.forge
          .checksOn(about.repo, about.commit)
          .then((runs) => runs.filter((run) => run.state === 'failed' || run.state === 'timed out'))
          .catch(() => [])
    const logs: string[] = []
    if (about?.forge.capabilities.checkLogs) {
      for (const run of failed.slice(0, LOGS)) {
        const log = await about.forge
          .checkLogOn(about.repo, run.commit, run.check, 200)
          .catch((err: unknown) => `its log could not be read: ${why(err)}`)
        logs.push(
          `### ${run.check}, as CI printed it`,
          '',
          '```',
          log.trimEnd() || 'nothing was kept',
          '```',
          '',
        )
      }
    }
    if (failed.length > LOGS) {
      logs.push(
        `${failed.length - LOGS} more failed; read their logs yourself if these do not say why.`,
        '',
      )
    }
    return {
      title: finding.title.slice(0, 80),
      prompt: fixing
        ? [
            'CI is failing on the branch this project is on. Reproduce it here before you change anything — what failed, the commit it failed on and the tail of each log are in your context file.',
            'A test that fails because the code disproved its premise is fixed by correcting the premise, never by deleting the test; a race is fixed by removing the race, never by loosening the assertion that caught it.',
            'Then fix the cause and push. Never force-push, never revert somebody else’s commit, and never merge anything: if the fix is not yours to make, say so and stop.',
          ].join(' ')
        : [
            enough
              ? `This branch has already had ${spent} automatic fix${spent === 1 ? '' : 'es'} in the last ${FIXING_HOURS} hours and CI is still red, so nobody should be fixing it again unasked.`
              : 'The settings do not let checks be fixed without asking.',
            'Say what broke and what you would do about it — reproduce it here first, so what you say is what happens rather than what you expect. Change nothing and push nothing.',
          ].join(' '),
      context: [
        `# ${finding.title}`,
        '',
        finding.detail ?? '',
        '',
        'Reproduce it here before changing anything. What CI runs is what this project’s own checks run, so run them.',
        '',
        '## What failed',
        '',
        ...logs,
      ].join('\n'),
      links: finding.links ?? [],
    }
  },
}

/**
 * A look that found nothing red, and what it is worth telling somebody.
 *
 * Several kinds of quiet, and they must not be one: everything passing,
 * something still running, nothing having run yet, nothing pushed yet and a
 * project with no forge behind it are all facts about a repository nothing is
 * wrong with. So they are `found: []`, with a sentence where there is one worth
 * saying — kept with the look and said when it starts being true, not at every
 * look while it stays true. A look that could not look throws, which is the one
 * of these that needs a person — and where nothing came back at all it throws
 * `Unreachable`, which is the one that might need nobody.
 */
function quietly(ci: CommitCi, since: string): { found: Finding[]; since: string; said?: string } {
  // Nothing came back at all is the one of these that might not be about this
  // repository: thrown as `Unreachable` so the scheduler's reach gets to ask
  // whether the machine has a network before anybody sees a red line about it.
  if (ci.kind === 'unreachable') throw new Unreachable(ci.host, ci.said)
  if (cannotLook(ci)) throw new Error(ci.said)
  const said = saidOf(ci)
  return { found: [], since, ...(said ? { said } : {}) }
}

/** A handful of names as a person would say them: `tests`, `types and tests`, `format, types and 2 more`. */
function said(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
