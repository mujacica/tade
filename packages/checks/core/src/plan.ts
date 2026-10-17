import { HOOK_ID } from './hooks.ts'
import type { Check } from './port.ts'
import { RunnerError } from './port.ts'

// What of a project's checks would run for a commit, and in what order.
//
// Pure: it is handed the checks and answers with the ones that apply. Nothing
// here reads a file, so the window can ask it on every look and the CLI can
// ask it with no workbench open.

/**
 * What would run for a commit: what applies, in an order that respects `needs`.
 *
 * Two runs, and they never mix. The **full** one is every check but the
 * related one (`Check.related`), which would only run a few of the tests the
 * suite beside it runs anyway. The **related** one (`related: true`) is the
 * commit hook and the related check and nothing else: an agent's quick look,
 * which no rollup counts as the full run. Naming a check in `only` is asking
 * for it, whichever run it belongs to.
 */
export function planFor(
  checks: readonly Check[],
  at: { changed?: readonly string[]; only?: readonly string[]; related?: boolean } = {},
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
    if (only.length === 0 && check.related !== true && at.related && check.id !== HOOK_ID) {
      return false
    }
    if (only.length === 0 && check.related === true && !at.related) return false
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
