import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Check } from './port.ts'

// The tests a change touches, as a project says it runs them.
//
// A full suite answers "does all of it still work"; an agent finishing one
// change mostly needs "do the tests that import what I changed still pass",
// in a minute rather than in five. Which tests those are is the project's own
// answer, read like everything else here — out of what it already says, never
// worked out by Tade and never chosen by a model or a judge, because choosing
// what not to run is the opposite of adding caution.
//
// What it says is a script called `test:related` in its `package.json`: the
// one convention this reads, and only as a fact the file states. Given paths
// it runs the tests those paths touch; given none, the tests the uncommitted
// changes touch. Tade's own is `scripts/related.ts`, over vitest's import graph.
//
// It is never the suite. The check it becomes is `related`, never required and
// never in a full run (`planFor`), so a related run passing leaves the rollup
// where it was: `unknown` until the full checks have run at that tree.

/** The id the check always has. */
export const RELATED_ID = 'related'

/** The script it is read from. */
export const RELATED_SCRIPT = 'test:related'

/** Lockfiles, and the program each one says runs this project's scripts. */
const MANAGERS: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const KNOWN = new Set(MANAGERS.map(([, manager]) => manager))

/** How long a related run is given: it is the quick look, and past this it has hung. */
const MINUTES = 15

/** What the reading found: the check, or nothing — and what it could not read, said. */
export interface RelatedReading {
  check: Check | null
  unread: string[]
}

const NOTHING: RelatedReading = { check: null, unread: [] }

/**
 * The project's related-tests check, or null where it says nothing about one.
 * Reads files and nothing else, like the rest of the reading, and a manifest
 * it cannot read is named in `unread` rather than read as one without the
 * script.
 */
export async function readRelated(root: string): Promise<RelatedReading> {
  let text: string
  try {
    text = await readFile(join(root, 'package.json'), 'utf8')
  } catch (err) {
    if (missing(err)) return NOTHING
    return {
      check: null,
      unread: [
        `package.json could not be read (${said(err)}), so ${RELATED_SCRIPT} was not looked for`,
      ],
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return {
      check: null,
      unread: [
        `package.json is not readable JSON (${said(err)}), so ${RELATED_SCRIPT} was not read`,
      ],
    }
  }
  if (typeof json !== 'object' || json === null) return NOTHING
  const raw = json as Record<string, unknown>
  const scripts = raw.scripts as Record<string, unknown> | undefined
  if (typeof scripts?.[RELATED_SCRIPT] !== 'string' || scripts[RELATED_SCRIPT].trim() === '') {
    return NOTHING
  }
  const manager = await managerOf(root, raw.packageManager)
  return {
    check: {
      id: RELATED_ID,
      title: 'Tests the change touches',
      run: `${manager} run ${RELATED_SCRIPT}`,
      // It holds its own turn, through the project's runner: a run of a few
      // files goes straight through and one the size of the suite waits for
      // the machine (Tade's own does, in `test/one-suite.ts`).
      alone: false,
      minutes: MINUTES,
      required: false,
      related: true,
      from: `package.json › ${RELATED_SCRIPT}`,
    },
    unread: [],
  }
}

/** Which program runs the project's scripts: what it declares, then its lockfile, then npm. */
async function managerOf(root: string, declared: unknown): Promise<string> {
  const named = typeof declared === 'string' ? (declared.split('@')[0] ?? '') : ''
  if (KNOWN.has(named)) return named
  for (const [lockfile, manager] of MANAGERS) {
    const info = await stat(join(root, lockfile)).catch((err: unknown) => {
      if (missing(err)) return null
      throw err
    })
    if (info?.isFile()) return manager
  }
  return 'npm'
}

/** Nothing there, which is an answer; anything else is a look that failed. */
function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function said(err: unknown): string {
  return (
    (err as NodeJS.ErrnoException | null)?.code ??
    (err instanceof Error ? err.message : String(err))
  )
}
