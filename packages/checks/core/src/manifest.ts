import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Check, ProjectRef } from './port.ts'
import { RunnerError } from './port.ts'

// What a project checks, and where that is written down.
//
// In order: the manifest the project commits (`.tade/checks.yaml`), then its
// workflows read best-effort, then the one `test_command` Tade has always had.
// A project with none of them has no checks, and the window says so rather
// than pretending everything is green.
//
// This is a parser of an external format, so it never throws on a shape it
// does not know: what it could not read comes back in `problems`, beside
// whatever it could.

/** Where a project's checks came from, for the sentence that says so. */
export type ChecksSource = 'manifest' | 'workflows' | 'test command' | 'none'

/** What the generated workflow needs that the checks themselves do not say. */
export interface CiSpec {
  /** The runners CI uses. */
  runs_on: readonly string[]
  /** The Node version CI sets up; null where the project is not Node. */
  node: string | null
  /** Steps before the checks — checkout, toolchain, install — as workflow steps, verbatim. */
  setup: readonly Record<string, unknown>[]
}

export interface ChecksManifest {
  checks: readonly Check[]
  ci: CiSpec
  source: ChecksSource
  /** The file it was read from, relative to the project; null when there was none. */
  from: string | null
  /** What could not be read, in sentences a person can act on. */
  problems: readonly string[]
}

export const MANIFEST_PATH = '.tade/checks.yaml'

const DEFAULT_MINUTES = 10

const EMPTY_CI: CiSpec = { runs_on: ['ubuntu-latest'], node: null, setup: [] }

/**
 * A project's checks, from the first source that has any. Reads files and
 * nothing else: no processes, no network, safe to call from a draw-adjacent
 * poll or from the CLI with the window closed.
 */
export async function readChecks(
  project: ProjectRef & { test?: string | undefined },
): Promise<ChecksManifest> {
  const manifest = await fromManifest(project.root)
  if (manifest) return manifest
  const workflows = await fromWorkflows(project.root)
  if (workflows) return workflows
  if (project.test) {
    return {
      checks: [
        {
          id: 'tests',
          title: 'Tests',
          run: project.test,
          alone: true,
          minutes: DEFAULT_MINUTES,
          required: true,
        },
      ],
      ci: EMPTY_CI,
      source: 'test command',
      from: null,
      problems: [],
    }
  }
  return { checks: [], ci: EMPTY_CI, source: 'none', from: null, problems: [] }
}

/** The manifest a project commits, when it has one. Null when there is no file. */
async function fromManifest(root: string): Promise<ChecksManifest | null> {
  let text: string
  try {
    text = await readFile(join(root, MANIFEST_PATH), 'utf8')
  } catch {
    return null
  }
  const problems: string[] = []
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (err) {
    return {
      checks: [],
      ci: EMPTY_CI,
      source: 'manifest',
      from: MANIFEST_PATH,
      problems: [
        `${MANIFEST_PATH} is not readable YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
  const raw = asObject(parsed)
  const list = Array.isArray(raw?.checks) ? raw.checks : []
  const checks: Check[] = []
  for (const [index, entry] of list.entries()) {
    const one = asObject(entry)
    const id = typeof one?.id === 'string' ? one.id.trim() : ''
    const run = typeof one?.run === 'string' ? one.run.trim() : ''
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      problems.push(`${MANIFEST_PATH}: check ${index + 1} has no usable id (lowercase, dashes)`)
      continue
    }
    if (!run) {
      problems.push(`${MANIFEST_PATH}: ${id} has no command to run`)
      continue
    }
    if (checks.some((already) => already.id === id)) {
      problems.push(`${MANIFEST_PATH}: two checks are called ${id}`)
      continue
    }
    checks.push({
      id,
      title: typeof one?.title === 'string' && one.title.trim() ? one.title.trim() : id,
      run,
      alone: one?.alone === true,
      minutes: typeof one?.minutes === 'number' && one.minutes > 0 ? one.minutes : DEFAULT_MINUTES,
      required: one?.required !== false,
      ...(Array.isArray(one?.when) ? { when: one.when.map(String) } : {}),
      ...(Array.isArray(one?.needs) ? { needs: one.needs.map(String) } : {}),
    })
  }
  for (const check of checks) {
    for (const need of check.needs ?? []) {
      if (!checks.some((one) => one.id === need)) {
        problems.push(`${MANIFEST_PATH}: ${check.id} needs ${need}, which is not a check here`)
      }
    }
  }
  return {
    checks,
    ci: ciFrom(asObject(raw?.ci)),
    source: 'manifest',
    from: MANIFEST_PATH,
    problems,
  }
}

function ciFrom(raw: Record<string, unknown> | null): CiSpec {
  if (!raw) return EMPTY_CI
  const runsOn = Array.isArray(raw.runs_on) ? raw.runs_on.map(String).filter(Boolean) : []
  const setup = Array.isArray(raw.setup)
    ? raw.setup.flatMap((step) => {
        const one = asObject(step)
        return one ? [one] : []
      })
    : []
  return {
    runs_on: runsOn.length > 0 ? runsOn : EMPTY_CI.runs_on,
    node:
      typeof raw.node === 'string'
        ? raw.node
        : typeof raw.node === 'number'
          ? String(raw.node)
          : null,
    setup,
  }
}

/**
 * The project's workflows, read for what they run. Best-effort and says so: a
 * step that is somebody's action rather than a command cannot be reproduced
 * here, and what needs a secret, a service or the matrix is named and skipped
 * rather than quietly dropped — a check nobody ran must never read as passed.
 */
async function fromWorkflows(root: string): Promise<ChecksManifest | null> {
  const dir = join(root, '.github', 'workflows')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort()
  } catch {
    return null
  }
  if (files.length === 0) return null
  const checks: Check[] = []
  const problems: string[] = []
  let from: string | null = null
  const taken = new Set<string>()
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = parseYaml(await readFile(join(dir, file), 'utf8'))
    } catch {
      problems.push(`.github/workflows/${file} is not readable YAML`)
      continue
    }
    const jobs = asObject(asObject(parsed)?.jobs)
    if (!jobs) continue
    for (const [jobName, value] of Object.entries(jobs)) {
      const job = asObject(value)
      const steps = Array.isArray(job?.steps) ? job.steps : []
      if (job?.services) {
        problems.push(`${file}: the job ${jobName} needs service containers, which run only in CI`)
      }
      for (const entry of steps) {
        const step = asObject(entry)
        const run = typeof step?.run === 'string' ? step.run.trim() : ''
        if (!run) continue
        const name = typeof step?.name === 'string' ? step.name : ''
        const id = uniqueId(name || firstWords(run), taken)
        const needsCi = /\$\{\{/.test(run)
        checks.push({
          id,
          title: name || run.split('\n')[0] || id,
          run,
          alone: false,
          minutes: DEFAULT_MINUTES,
          required: true,
          ...(needsCi ? { skip: 'needs CI: it uses something only the runner knows' } : {}),
        })
        from = `.github/workflows/${file}`
      }
    }
  }
  if (checks.length === 0) return null
  problems.push(
    'These were read from the workflows, which is a guess: write .tade/checks.yaml to say exactly what this project checks.',
  )
  return { checks, ci: EMPTY_CI, source: 'workflows', from, problems }
}

function firstWords(run: string): string {
  return (run.split('\n')[0] ?? '').split(' ').slice(0, 3).join('-')
}

function uniqueId(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'check'
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/** What would run for a commit: what applies, in an order that respects `needs`. */
export function planFor(
  checks: readonly Check[],
  at: { changed?: readonly string[]; only?: readonly string[] } = {},
): Check[] {
  const only = at.only?.filter((id) => id.trim() !== '') ?? []
  if (only.length > 0) {
    const unknown = only.filter((id) => !checks.some((check) => check.id === id))
    if (unknown.length > 0) {
      throw new RunnerError(
        'unknown',
        `there is no check called ${unknown.join(', ')} (there is ${checks.map((one) => one.id).join(', ') || 'none'})`,
      )
    }
  }
  const changed = at.changed
  const applies = (check: Check): boolean => {
    if (only.length > 0 && !only.includes(check.id)) return false
    // No list of changed paths means we cannot narrow: run it. Narrowing on an
    // unknown is how a check silently stops running.
    if (!check.when || check.when.length === 0 || changed === undefined) return true
    return changed.some((path) => check.when?.some((glob) => matches(glob, path)))
  }
  const wanted = checks.filter(applies)
  return inOrder(wanted)
}

/** `needs` before what needs it. Throws `refused`, naming the cycle, when there is one. */
export function inOrder(checks: readonly Check[]): Check[] {
  const byId = new Map(checks.map((check) => [check.id, check]))
  const done = new Set<string>()
  const open: string[] = []
  const out: Check[] = []
  const visit = (check: Check) => {
    if (done.has(check.id)) return
    if (open.includes(check.id)) {
      throw new RunnerError(
        'refused',
        `these checks wait on each other and none can run: ${[...open.slice(open.indexOf(check.id)), check.id].join(' → ')}`,
      )
    }
    open.push(check.id)
    for (const need of check.needs ?? []) {
      const next = byId.get(need)
      if (next) visit(next)
    }
    open.pop()
    done.add(check.id)
    out.push(check)
  }
  for (const check of checks) visit(check)
  return out
}

/** Whether a path matches a glob: `*` within a segment, `**` across them, `?` one character. */
export function matches(glob: string, path: string): boolean {
  const source = glob
    .split('/')
    .map((part) =>
      part === '**'
        ? '.*'
        : part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
    )
    .join('/')
    .replace(/\.\*\//g, '(?:.*/)?')
  return new RegExp(`^${source}$`).test(path)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
