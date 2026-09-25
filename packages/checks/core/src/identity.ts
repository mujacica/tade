import type { Check, CheckRun } from './port.ts'

// What a check is called, and how a rename stops orphaning its history.
//
// A check's id is the step's own name, because that is the name a person typed,
// the name CI shows on its row, and the name somebody types at `checks_run`.
// Deriving one from the command instead reads worse and is not even stable:
// `pnpm exec biome ci .`, `pnpm exec tsc …` and `node scripts/coverage.ts` all
// have the same program.
//
// The objection to a name being an id is real, though: somebody retitles a
// step and every run recorded under the old name is orphaned. The answer is
// `carryOver`'s, one level up. A run already survives the commit after it,
// because what makes a run true of a commit is not the commit's id but the
// bytes it read — so:
//
//   a run recorded under an earlier id still stands for this check when the
//   command is the same.
//
// `CheckRun.ran` is the command a run ran, and `followRenames` relabels a run
// whose id is gone onto the check whose command it matches. A rename therefore
// costs nothing and nobody has to pin anything. Runs recorded before `ran`
// existed cannot be followed, which is `turn_started`'s situation exactly: the
// record is append-only, so the only cure is time.

/**
 * Command wrappers that say how to reach a program rather than which program.
 * `pnpm exec biome ci .` and `biome ci .` are one command, so a hook and a
 * workflow step that spell it differently are one check.
 */
const DELEGATES: readonly string[] = [
  'pnpm exec',
  'pnpm run',
  'pnpm dlx',
  'npm run',
  'npm exec',
  'yarn run',
  'bun run',
  'bunx',
  'npx --yes',
  'npx -y',
  'npx',
  'uv run',
  'uvx',
  'poetry run',
  'pipenv run',
  'bundle exec',
  'rye run',
  'hatch run',
]

/**
 * Interpreters whose first argument is the interesting part: `node
 * scripts/coverage.ts` is the coverage check, not the node check.
 */
const INTERPRETERS: readonly string[] = [
  'node',
  'python',
  'python3',
  'ruby',
  'deno',
  'bun',
  'sh',
  'bash',
  'zsh',
]

/**
 * A command as identity rather than as text: one line, whitespace collapsed,
 * and the wrapper that only says how to reach the program taken off.
 *
 * Deliberately not a shell parse. Two spellings of one command have to compare
 * equal — that is all this is for — and anything cleverer would start deciding
 * that two genuinely different commands are the same, which is the direction
 * that makes a check go quietly green.
 */
export function normaliseCommand(run: string): string {
  let text = run.replace(/\s+/g, ' ').trim()
  // Repeatedly, because `pnpm run check` can hold `pnpm exec biome ci .`, and
  // because `npx pnpm exec …` exists in the wild.
  for (let again = true; again; ) {
    again = false
    for (const delegate of DELEGATES) {
      if (text.toLowerCase().startsWith(`${delegate} `)) {
        text = text.slice(delegate.length + 1).trim()
        again = true
        break
      }
    }
  }
  return text
}

/** Whether two commands are the same command, however they are spelled. */
export function sameCommand(one: string, other: string): boolean {
  return normaliseCommand(one) === normaliseCommand(other)
}

/** A word as a check id: lowercase, dashes, and nothing else. Empty where there is no word in it. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * What to call a check nobody named: the program it runs, or the script that
 * program runs where the program is an interpreter. A last resort — a named
 * step keeps its name.
 */
export function calledAfter(run: string): string {
  const words = normaliseCommand(run).split(' ').filter(Boolean)
  const first = words[0] ?? ''
  if (INTERPRETERS.includes(first.toLowerCase())) {
    // The first thing that is not a flag: `node --test scripts/x.ts`.
    const script = words.slice(1).find((word) => !word.startsWith('-'))
    const name = (script ?? '').split('/').at(-1) ?? ''
    return slug(name.replace(/\.[a-z]+$/i, '')) || slug(first)
  }
  return slug(first.split('/').at(-1) ?? '') || 'check'
}

/**
 * The id for a step: its name, or what it runs where it has none. Unique
 * within a reading — a second `test` becomes `test-2` — because two rows with
 * one id is two things the window draws as one.
 */
export function idFor(name: string, run: string, taken: Set<string>): string {
  const base = slug(name) || calledAfter(run)
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

/**
 * Relabel runs whose check id is no longer one of these checks onto the check
 * whose command they ran. This is what makes retitling a step cost nothing.
 *
 * Only ever onto a check that has no run of its own at that commit, and only
 * where exactly one check runs that command: a relabelling that had to choose
 * would be a guess, and a guess here reads as a green tick. Everything it
 * cannot place is left exactly as it was, so a run under a name nobody uses
 * any more is still in the record, still readable, and simply not counted.
 */
export function followRenames<T extends CheckRun>(
  checks: readonly Check[],
  runs: readonly T[],
): T[] {
  const ids = new Set(checks.map((check) => check.id))
  const strays = runs.filter((run) => !ids.has(run.check) && run.ran)
  if (strays.length === 0) return [...runs]
  // One command, one check, or nothing: a command two checks share cannot say
  // which of them an old run was.
  const byCommand = new Map<string, string | null>()
  for (const check of checks) {
    const key = normaliseCommand(check.run)
    byCommand.set(key, byCommand.has(key) ? null : check.id)
  }
  return runs.map((run) => {
    if (ids.has(run.check) || !run.ran) return run
    const now = byCommand.get(normaliseCommand(run.ran))
    return now ? { ...run, check: now } : run
  })
}
