import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import type { ChecksManifest, CiSpec } from './manifest.ts'
import { MANIFEST_PATH, readFromCi } from './manifest.ts'
import type { Check } from './port.ts'
import { RunnerError } from './port.ts'

// Writing down what a project checks.
//
// `.tade/checks.yaml` is the one file Tade writes into somebody else's
// repository, and it is theirs afterwards: a person edits it, CI is generated
// from it, and git is the undo. So this never commits — `recordAuthored` is
// for `<home>`, where there is no other history to lose, and running it over a
// project's checkout would sweep up whatever four agents had half-written.
// Here the change lands in the working tree, where `git diff` shows it and
// `git checkout` takes it back.
//
// Amending goes through the YAML *document* rather than parse-and-stringify,
// because the comments in this file are a person explaining why a check needs
// the machine to itself, and losing those is losing the only place that was
// written down.

/** A check as somebody asks for it: an id and a command, and the rest by default. */
export interface CheckDraft {
  id: string
  run: string
  title?: string | undefined
  alone?: boolean | undefined
  minutes?: number | undefined
  required?: boolean | undefined
  when?: readonly string[] | undefined
  needs?: readonly string[] | undefined
}

/** What writing a manifest did, for the sentence somebody reads afterwards. */
export interface Written {
  /** Relative to the project, so it reads the same wherever it is said. */
  path: string
  /** Ids now in the file, in the order they run. */
  ids: readonly string[]
  /** Whether the file was there already. */
  amended: boolean
}

const ID = /^[a-z0-9][a-z0-9-]*$/

const HEADER = [
  '# What this project checks. Tade runs exactly these, in this order, and',
  '# `tade checks workflow --write` generates CI from the same file — so the',
  '# gate on your machine and the gate in CI cannot drift apart.',
]

/**
 * Check a draft before anything is written. Throws `refused`, naming what is
 * wrong, because a manifest written from a bad draft is a file somebody has to
 * find and fix by hand.
 */
function checked(draft: CheckDraft, taken: ReadonlySet<string>): Check {
  const id = draft.id.trim()
  const run = draft.run.trim()
  if (!ID.test(id)) {
    throw new RunnerError(
      'refused',
      `${id || '(no id)'} is not a usable check id (lowercase, dashes)`,
    )
  }
  if (!run) throw new RunnerError('refused', `${id} has no command to run`)
  if (taken.has(id)) throw new RunnerError('refused', `there is already a check called ${id}`)
  return {
    id,
    title: draft.title?.trim() || id,
    run,
    alone: draft.alone === true,
    minutes: draft.minutes && draft.minutes > 0 ? draft.minutes : 10,
    required: draft.required !== false,
    ...(draft.when && draft.when.length > 0 ? { when: [...draft.when] } : {}),
    ...(draft.needs && draft.needs.length > 0 ? { needs: [...draft.needs] } : {}),
  }
}

/** A check as the file holds it: only what differs from the defaults, so it stays readable. */
function entryOf(check: Check): Record<string, unknown> {
  return {
    id: check.id,
    ...(check.title !== check.id ? { title: check.title } : {}),
    run: check.run,
    ...(check.alone ? { alone: true } : {}),
    ...(check.minutes !== 10 ? { minutes: check.minutes } : {}),
    ...(check.required ? {} : { required: false }),
    ...(check.when ? { when: [...check.when] } : {}),
    ...(check.needs ? { needs: [...check.needs] } : {}),
  }
}

/** A whole manifest as text, with the header that says where CI comes from. */
export function checksYaml(checks: readonly Check[], ci?: CiSpec): string {
  const doc = new Document({
    checks: checks.map(entryOf),
    ...(ci && (ci.node || ci.setup.length > 0 || ci.runs_on.length > 1)
      ? { ci: { runs_on: [...ci.runs_on], ...(ci.node ? { node: ci.node } : {}), setup: ci.setup } }
      : {}),
  })
  doc.commentBefore = HEADER.map((line) => line.replace(/^# ?/, '')).join('\n')
  return doc.toString({ lineWidth: 0 })
}

/**
 * Write these checks as the project's manifest, replacing whatever was there.
 * Used by adoption, which is a whole reading at once.
 */
export async function writeChecks(
  root: string,
  checks: readonly Check[],
  ci?: CiSpec,
): Promise<Written> {
  const taken = new Set<string>()
  const ok = checks.map((check) => {
    const one = checked(check, taken)
    taken.add(one.id)
    return one
  })
  const path = join(root, MANIFEST_PATH)
  const amended = await readFile(path, 'utf8').then(
    () => true,
    () => false,
  )
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, checksYaml(ok, ci), 'utf8')
  return { path: MANIFEST_PATH, ids: ok.map((one) => one.id), amended }
}

/**
 * Add or replace checks in the project's manifest, keeping everything else in
 * the file — the other checks, the `ci:` block, and every comment somebody
 * wrote. A check whose id is already there is replaced in place, so amending
 * twice says the same thing as amending once.
 *
 * With no file yet it writes one, which is what makes this the single call the
 * orchestrator, the CLI and the window all make.
 */
export async function amendChecks(
  root: string,
  drafts: readonly CheckDraft[],
  opts: { remove?: readonly string[] } = {},
): Promise<Written> {
  if (drafts.length === 0 && (opts.remove?.length ?? 0) === 0) {
    throw new RunnerError('refused', 'nothing to add and nothing to remove')
  }
  const path = join(root, MANIFEST_PATH)
  let text: string | null
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = null
  }
  if (text === null) {
    const taken = new Set<string>()
    const made = drafts.map((draft) => {
      const one = checked(draft, taken)
      taken.add(one.id)
      return one
    })
    return writeChecks(root, made)
  }
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new RunnerError(
      'refused',
      `${MANIFEST_PATH} is not readable YAML, so it will not be written over: ${doc.errors[0]?.message ?? 'unparseable'}`,
    )
  }
  // `toJS` over the document, rather than reading the node: what is wanted is
  // the ids in order, and the node is kept only so the comments survive.
  const whole = doc.toJS() as { checks?: unknown } | null
  const existing: unknown[] = Array.isArray(whole?.checks) ? whole.checks : []
  const idsAt = existing.map((one) =>
    typeof one === 'object' && one !== null ? String((one as { id?: unknown }).id ?? '') : '',
  )
  for (const id of opts.remove ?? []) {
    const at = idsAt.indexOf(id)
    if (at < 0) throw new RunnerError('unknown', `there is no check called ${id} to remove`)
    doc.deleteIn(['checks', at])
    idsAt.splice(at, 1)
  }
  for (const draft of drafts) {
    const at = idsAt.indexOf(draft.id.trim())
    // Replacing keeps the position, so a `needs` order somebody arranged by
    // hand survives an amendment to one of its checks.
    const one = checked(draft, at < 0 ? new Set(idsAt.filter(Boolean)) : new Set())
    if (at >= 0) doc.setIn(['checks', at], entryOf(one))
    else {
      doc.addIn(['checks'], entryOf(one))
      idsAt.push(one.id)
    }
  }
  await writeFile(path, doc.toString({ lineWidth: 0 }), 'utf8')
  return {
    path: MANIFEST_PATH,
    ids: idsAt.filter(Boolean),
    amended: true,
  }
}

/** What adopting the project's CI config would write, and what it could not take. */
export interface Adoption {
  checks: readonly Check[]
  /** The CI config it was read from, relative to the project. */
  from: string | null
  /** What could not be taken, each a sentence naming the step and why. */
  couldNotTake: readonly string[]
  /** The file it would write, so `--dry-run` can show it. */
  text: string
}

/**
 * Read the project's CI config as a manifest it could adopt. Null when there
 * is nothing to read.
 *
 * Reads at `run` fidelity deliberately: adoption is the act that makes these
 * checks ours, so what it writes down is what would actually run, and the
 * steps that genuinely cannot run here keep their own reason.
 */
export async function adoptable(root: string): Promise<Adoption | null> {
  const read: ChecksManifest | null = await readFromCi(root, 'run')
  if (!read) return null
  // A step only the runner can do is named rather than written into the
  // manifest: a check in that file is a promise that running it means
  // something, and one that can never run here is not.
  const take = read.checks.filter((check) => !check.skip)
  const couldNotTake = [
    ...read.checks.flatMap((check) => (check.skip ? [`${check.id}: ${check.skip}`] : [])),
    // The last problem is the "this is a guess" line, which is advice about
    // adopting and not a thing that could not be adopted.
    ...read.problems.slice(0, -1),
  ]
  return { checks: take, from: read.from, couldNotTake, text: checksYaml(take) }
}
