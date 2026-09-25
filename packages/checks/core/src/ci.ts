import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { idFor } from './identity.ts'
import type { Check } from './port.ts'

// What a project's CI already says it checks.
//
// This used to be a best-effort reading that nothing was allowed to run,
// because "a CI config holds releases and deploys beside its tests and nothing
// can tell which is which". That was wrong, and the reason it was wrong is
// that nobody had read the *triggers*. A release is not told from a gate by
// the wording of a step name; it is told by facts the file states about itself:
//
//   on: pull_request / push: branches:   this runs on every change — the gate
//   on: push: tags: / release:           this ships something
//   environment:                         GitHub's own word for a deploy target
//   permissions: …: write                it publishes rather than checks
//   services:                            it needs a database only CI has
//   ${{ … }} in a run:                   it needs what only the runner knows
//   no run:                              it is somebody's action
//
// So the rule is a conjunction of declared facts, and the design principle
// underneath it is one sentence:
//
//   **Reading may only ever narrow what Tade claims.**
//
// Everything this cannot place is *named* rather than run. The failure mode is
// therefore "Tade checked less than CI does, and said so", never "Tade ran a
// deploy" — which is what makes reading safe enough to be the definition
// rather than a suggestion.
//
// A parser of an external format: it never throws on a shape it does not know.
//
// **What this does to the trust boundary, said out loud.** These commands are
// run through a shell, and they now come out of `.github/workflows/` rather
// than out of `.tade/checks.yaml`. Both are files in the branch that is checked
// out, so the level is the one it always was — whoever can write a file in this
// checkout decides what a check runs, and an agent working here is already
// running that branch's build and its tests with nothing containing it. What
// *did* change is the default: `checks.from_ci: 'show'` used to mean a command
// read from CI was never run until somebody adopted it, and a workflow's
// commands now run without that step. The reason that is the right trade is
// that adoption was never a reading of the command — it was a person pressing a
// button — and a branch nobody trusts is not one to run any of Tade's checks
// in. A branch from a fork is the case to have in mind, and the answer to it is
// the same answer as for everything else an agent does in a checkout: it is the
// harness's or the agent's, never a manifest's.
//
// One more distinction, and it is the one that decides what a person sees.
//
// A step that is **not a check at all** — somebody's action, an install that
// prepares the machine, a job that deploys, a workflow that ships a release —
// is named in `unread` and is nowhere else, because there is nothing about it
// for a page about checks to draw.
//
// A step that **is** a check and cannot run *here* — it interpolates something
// only the runner knows, its job needs a database — is a check with a `skip`
// and `required: false`. It keeps its row, which says *cannot run here* and
// why; and it is out of the rollup, because a rollup is what a run *here* adds
// up to, and a project with one `${{ secrets.… }}` step would otherwise be
// unknown for ever. `required` means merging waits on it: CI still holds on
// these, and Tade never claimed to be CI.

/** A reading of somebody else's config: what it found, from where, and what it left. */
export interface Reading {
  checks: readonly Check[]
  /** The files it was read from, relative to the project, in reading order. */
  from: readonly string[]
  /**
   * Everything that did not become a check, each a sentence naming the thing
   * and why. Complete on purpose: a step dropped in silence is how somebody
   * comes to believe Tade checks something it has never looked at.
   */
  unread: readonly string[]
}

const WORKFLOWS = join('.github', 'workflows')

/** No `timeout-minutes` anywhere: long enough for a suite, short enough to end a hang. */
const DEFAULT_MINUTES = 20

/** Past this a declared timeout is CI's patience, not a local run's. */
const MOST_MINUTES = 60

/**
 * Commands that prepare the machine rather than check the code. A failing
 * `pnpm install` means the network is down, and a check whose red light means
 * that is a check that cries wolf.
 *
 * The one rule here that is a list of verbs rather than a fact the file
 * states — and it is safe because it may only ever *exclude*, which is the
 * direction that makes Tade claim less.
 */
const SETUP =
  /(^|\s|&&|\|\||;)(?:sudo\s+)?(?:(?:pnpm|npm|yarn|bun)\s+(?:install|ci|i)\b|corepack\s+enable\b|(?:pip|pip3)\s+install\b|uv\s+sync\b|poetry\s+install\b|bundle\s+install\b|apt(?:-get)?\s+(?:update|install)\b|brew\s+(?:install|update)\b|choco\s+install\b|go\s+mod\s+download\b|cargo\s+fetch\b)/

/** Permissions that mean a job changes something outside the repository. */
function publishes(permissions: unknown): string | null {
  if (typeof permissions === 'string') {
    return permissions === 'write-all' ? 'write-all' : null
  }
  const raw = asObject(permissions)
  if (!raw) return null
  for (const [scope, level] of Object.entries(raw)) {
    if (level === 'write' && scope !== 'contents') return `${scope}: write`
  }
  return null
}

/**
 * Whether this workflow is the gate every change goes through, and why not
 * where it is not. `workflow_call` on its own is somebody else's piece: what
 * calls it decides what it is, and guessing that it is a gate is the one guess
 * that could run a release.
 */
export function gateTrigger(on: unknown): { gate: true } | { gate: false; because: string } {
  if (typeof on === 'string') {
    return on === 'pull_request' || on === 'push'
      ? { gate: true }
      : { gate: false, because: `it runs on ${on}` }
  }
  const names = Array.isArray(on)
    ? on.map(String)
    : asObject(on)
      ? Object.keys(asObject(on) as Record<string, unknown>)
      : []
  if (names.length === 0) return { gate: false, because: 'it says nothing about when it runs' }
  if (names.includes('pull_request') || names.includes('pull_request_target')) return { gate: true }
  if (names.includes('push')) {
    const push = asObject(on) ? asObject(on)?.push : null
    const at = asObject(push)
    // A push with tags and no branches is a release. A push that says nothing
    // is every branch, which is the gate.
    if (!at) return { gate: true }
    if (at.branches || at['branches-ignore']) return { gate: true }
    if (at.tags || at['tags-ignore']) {
      return { gate: false, because: 'it runs on a tag, which is a release and not a gate' }
    }
    return { gate: true }
  }
  return { gate: false, because: `it runs on ${names.join(', ')} and not on a change` }
}

/**
 * What a project's CI checks on every change. Null where there are no
 * workflows to read at all — which is not the same as a project whose
 * workflows hold no checks, and reads differently to whoever is told.
 *
 * Reads files and nothing else: no processes, no network, safe from a
 * draw-adjacent poll.
 */
export async function readWorkflows(root: string): Promise<Reading | null> {
  const dir = join(root, WORKFLOWS)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort()
  } catch {
    return null
  }
  if (files.length === 0) return null
  const checks: Check[] = []
  const from: string[] = []
  const unread: string[] = []
  const taken = new Set<string>()
  for (const file of files) {
    const at = `${WORKFLOWS}/${file}`
    let parsed: unknown
    try {
      parsed = parseYaml(await readFile(join(dir, file), 'utf8'))
    } catch {
      unread.push(`${at} is not readable YAML, so nothing in it was read`)
      continue
    }
    const raw = asObject(parsed)
    // YAML 1.2 keeps `on` a plain key; a 1.1 parser would make it `true`.
    // Reading both so a parser change cannot silently empty every reading.
    const trigger = gateTrigger(raw?.on ?? raw?.true)
    if (!trigger.gate) {
      unread.push(`${at} was not read: ${trigger.because}`)
      continue
    }
    const before = checks.length
    readJobs(asObject(raw?.jobs), at, checks, unread, taken)
    if (checks.length > before) from.push(at)
  }
  if (checks.length === 0 && unread.length === 0) return null
  return { checks, from, unread }
}

function readJobs(
  jobs: Record<string, unknown> | null,
  at: string,
  checks: Check[],
  unread: string[],
  taken: Set<string>,
): void {
  if (!jobs) return
  for (const [name, value] of Object.entries(jobs)) {
    const job = asObject(value)
    const where = `${at} › ${name}`
    // A job that calls another workflow has no steps of its own. The workflow
    // it calls is read on its own terms, where it is a gate.
    if (typeof job?.uses === 'string') continue
    if (job?.environment) {
      unread.push(`${where} deploys to an environment, so none of it was read`)
      continue
    }
    const write = publishes(job?.permissions)
    if (write) {
      unread.push(`${where} asks for ${write}, so it publishes rather than checks`)
      continue
    }
    // These are checks the job really runs; what they need is what this machine
    // has not got. So they keep their rows and say so, rather than vanishing.
    const cannot = job?.services
      ? 'its job needs service containers, which only CI has'
      : job?.container
        ? 'its job runs in a container, which is not this machine'
        : typeof job?.if === 'string'
          ? `its job runs only when \`${job.if}\`, which only CI can answer`
          : null
    readSteps(Array.isArray(job?.steps) ? job.steps : [], where, checks, unread, taken, cannot)
  }
}

function readSteps(
  steps: readonly unknown[],
  where: string,
  checks: Check[],
  unread: string[],
  taken: Set<string>,
  jobCannot: string | null,
): void {
  for (const entry of steps) {
    const step = asObject(entry)
    const name = typeof step?.name === 'string' ? step.name.trim() : ''
    const said = name ? `${where} › ${name}` : where
    const run = typeof step?.run === 'string' ? step.run.trim() : ''
    if (!run) {
      const uses = typeof step?.uses === 'string' ? step.uses : ''
      // An action prepares the machine or talks to the forge; either way there
      // is no command here to run.
      if (uses) unread.push(`${said} is the action ${uses}, which only the runner can run`)
      continue
    }
    if (SETUP.test(run)) {
      unread.push(`${said} prepares the machine rather than checking the code`)
      continue
    }
    const cannot =
      jobCannot ??
      (/\$\{\{/.test(run) || /\$\{\{/.test(JSON.stringify(step?.env ?? ''))
        ? 'it uses something only the runner knows'
        : typeof step?.if === 'string'
          ? `it runs only when \`${step.if}\`, which only CI can answer`
          : null)
    checks.push({
      id: idFor(name, run, taken),
      title: name || run.split('\n')[0] || 'check',
      run,
      // Every step of a CI job has the runner to itself: steps go one at a
      // time on a machine nothing else is using. Running two of them side by
      // side here would be *less* faithful than CI, not more — and it is what
      // starves a suite's own subprocesses into looking like a regression.
      //
      // Steps of *different* jobs do go side by side in CI, and these do not,
      // which is the one thing this gives up. Faithful would need a check to
      // know which job it came from, and the trade is the safe direction: a
      // local run is never faster than CI and never starves anything. A
      // project that wants two of them at once has `checks.only`.
      alone: true,
      minutes: minutesOf(step, DEFAULT_MINUTES),
      // Declared, not assumed: a step CI is willing to be red on is a step
      // nothing should be held on here either. Nor is one nothing here can run:
      // it is drawn, and it is out of what a local run adds up to.
      required: step?.['continue-on-error'] !== true && cannot === null,
      from: where,
      ...(cannot ? { skip: `cannot run here: ${cannot}` } : {}),
    })
  }
}

function minutesOf(step: Record<string, unknown> | null, fallback: number): number {
  const said = step?.['timeout-minutes']
  const minutes = typeof said === 'number' ? said : Number(said)
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback
  return Math.min(MOST_MINUTES, Math.ceil(minutes))
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
