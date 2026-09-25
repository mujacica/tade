// A setting Tade used to have, and what is true without it.
//
// The two halves are here together on purpose. A key that is gone and the
// sentence saying what is now true instead are one change, and filed apart
// the sentence is what somebody tidying up deletes: it reads like a stray
// remark once nothing near it explains why anybody wrote it down.
//
// Pure: the object a YAML parser made in, the keys Tade no longer reads taken
// out of it, and a line about each. No filesystem, no clock — the file itself
// is never touched, because the file is the person's to edit.

/**
 * The short of it, for the one line a whole list of servers gets: `and
 * nothing here holds it`. A clause of the sentence below, and never a second
 * wording of it.
 */
export const SERVER_HELD_BY_NOTHING = 'nothing here holds it'

/**
 * What turning an MCP server on means, said wherever somebody is deciding to.
 *
 * `mcp.servers.<name>.sandbox` used to be a key, and a server that asked for
 * one and could not have it was listed broken rather than started loose —
 * which read like a promise that a server could be held. It could not: Tade
 * half-owned it, every default was `none`, and the program it was meant to
 * contain is one somebody deliberately handed the machine to. So the key is
 * gone and what is actually true is said instead — here, once, so the
 * Extensions page and `tade mcp enable` cannot drift apart about it.
 *
 * What is left is real and is all there is: a scratch directory of its own
 * (`<home>/mcp/<name>/`), an environment scrubbed to `PATH`, `HOME`, `TMPDIR`
 * and what the declaration names, and its own process group. None of that
 * stops the program reading or writing anything you can.
 */
export const SERVER_RUNS_AS_YOU =
  'A server is somebody else’s program and runs as you: a scratch directory of its own and an ' +
  `environment scrubbed to what it declared are all it gets, and ${SERVER_HELD_BY_NOTHING} — ` +
  'so turn on only what you would run yourself.'

/**
 * What a project checks, now that Tade has no list of its own.
 *
 * `checks.from_ci` chose what a reading of somebody's CI was good for — shown,
 * run, or ignored — because a reading was a guess and `.tade/checks.yaml` was
 * the definition. The reading is now the definition: it takes only what the
 * workflow file *states* is a gate, names everything it did not take, and
 * there is no manifest to adopt into, so there is nothing left for the key to
 * choose between.
 */
export const CHECKS_ARE_READ =
  'what a project checks is read from its CI workflows and its commit hook, so there is nothing to ' +
  'adopt and nothing to choose: use projects.<name>.test_command where neither can be read'

/**
 * Keys Tade used to read and does not any more, and what to say about each.
 *
 * A setting somebody wrote down is a sentence they meant. Refusing the whole
 * file over one is the worst of the three answers — it takes away everything
 * else they wrote at the same time — and accepting it silently is the other
 * wrong one, because a key Tade reads and ignores reads like a promise. So it
 * is dropped before the schema sees it and said in a line, which is what
 * makes it something a person can go and delete.
 *
 * Matched on the *shape* of the path, `*` standing for one segment, because
 * these live under names people chose. Tested by the two that exist today;
 * the list is what a third would join.
 */
const GONE: readonly (readonly [pattern: string, said: string])[] = [
  [
    'workers.routes.*.sandbox',
    'sandboxes are gone from Tade: agents run as you, and what needs containing is a harness’s or an agent’s to do',
  ],
  ['mcp.servers.*.sandbox', `sandboxes are gone from Tade. ${SERVER_RUNS_AS_YOU}`],
  ['checks.from_ci', CHECKS_ARE_READ],
  ['projects.*.checks.from_ci', CHECKS_ARE_READ],
]

/**
 * Whether the first `path.length` segments of `pattern` accept `path`, `*`
 * standing for any one segment. A whole match is the same question asked with
 * a path as long as the pattern.
 */
function shaped(path: readonly string[], pattern: readonly string[]): boolean {
  return (
    path.length <= pattern.length &&
    path.every((part, at) => pattern[at] === '*' || pattern[at] === part)
  )
}

/**
 * Take the settings Tade no longer has out of what was parsed, and say which.
 *
 * Walks only the paths a rule could still reach, so nothing else in somebody's
 * whole setup is looked at, let alone changed.
 */
export function dropGone(raw: unknown): string[] {
  const rules = GONE.map(([pattern, said]) => ({ at: pattern.split('.'), said }))
  const warnings: string[] = []
  const walk = (node: unknown, at: readonly string[]): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    for (const key of Object.keys(node)) {
      const here = [...at, key]
      const reached = rules.filter((rule) => shaped(here, rule.at))
      const whole = reached.find((rule) => rule.at.length === here.length)
      if (whole) {
        delete (node as Record<string, unknown>)[key]
        warnings.push(`${here.join('.')} is ignored: ${whole.said}`)
      } else if (reached.length > 0) {
        walk((node as Record<string, unknown>)[key], here)
      }
    }
  }
  walk(raw, [])
  return warnings
}
