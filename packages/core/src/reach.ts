import type { Setting } from './settings.ts'

// How far the orchestrator's arm reaches into the config.
//
// The orchestrator is ungated on purpose — asking permission to answer "where
// are we" is nobody's idea of useful — and it reads attacker-controlled text
// all day: review comments, an MCP server's tool descriptions, a page somebody
// pasted. So the question is never "can it be trusted", it is "what is the
// worst a sentence it read can do". That is a property of the *setting*, not
// of the model, which is why it is decided here, in a pure function, and not
// in a prompt.
//
// Three answers, and nothing else:
//
// - `never`  — no words are enough. Each one widens what an agent may do,
//              hands a third party tools or a credential, changes who is
//              asked, or changes where Tade sends something. Those are exactly
//              what an injected sentence wants, so the answer has to be that
//              there is no path, not a path with a warning on it.
// - `asked`  — only when the person's own words name it (`namedBy`, checked
//              against the journal by whoever holds one). This is the default:
//              changing a setting is never something to do as a side effect of
//              anything, so requiring their words is not friction on the act,
//              it is the act.
// - `open`   — an ordinary request is enough. The short list where the worst
//              case is a cosmetic annoyance the person is looking at.
//
// It may only ever *refuse*. Nothing here can widen what a tier allows, and
// nothing outside these tiers is writable at all.

/** How far the orchestrator may go with one setting. */
export type Reach = 'open' | 'asked' | 'never'

export interface Reaches {
  reach: Reach
  /** Why, in one clause — what a person is told when it is refused. */
  because: string
}

/**
 * Settings the orchestrator may change on an ordinary request.
 *
 * Deliberately short. What they have in common is that the worst case is a
 * cosmetic annoyance the person is already looking at and can undo in one
 * sentence — and `editor` is an enum of editors Tade knows, never a command.
 */
const OPEN: readonly string[] = [
  'surfaces.window.sidebar_width',
  'surfaces.window.strip_height',
  'surfaces.window.editor',
]

/**
 * What no words reach, as a prefix and the clause said when it is refused.
 *
 * Matched as a dotted prefix — `extensions` catches `extensions.sentry.org` as
 * well as `extensions.sentry.enabled` — because a subtree is a rule that holds
 * without anybody remembering which key inside it was the dangerous one. The
 * first match wins, so a longer path sits above the subtree it lives in.
 */
const NEVER: readonly (readonly [string, string])[] = [
  [
    'approvals',
    'approvals decide what agents may do without asking, and I relay them — a thing inside that loop does not get to rewrite it',
  ],
  ['accounts', 'an account is a sign-in: whose money and whose permissions agents run with'],
  ['workers.accounts', 'which sign-in agents run as is a sign-in decision'],
  ['workers.routes', 'a route carries the sandbox, which is what an agent may write to'],
  [
    'extensions',
    'an extension is code your agents call, and its own key lives here — turning one on or pointing it somewhere else is a person’s act',
  ],
  [
    'mcp',
    'an MCP server is somebody else’s code with tools your agents will call, and only a person turns one on',
  ],
  ['orchestrator.extensions', 'that is the folder my own tools are read from'],
  ['telemetry.dsn', 'a DSN is where Tade sends things, and I read pages all day'],
  [
    'projects',
    'moving a project’s root moves where every agent in it works — closing it and opening it again is two acts, each said',
  ],
]

/**
 * Paths under a `never` subtree that are not themselves dangerous.
 *
 * `projects` is the whole of a project's block, and most of it is ordinary:
 * what it may spend, the line I am told about it, its own answer to the check
 * rules, whether its agents share its checkout. Only `root` moves where the
 * work happens. Checked before `NEVER`, and a list rather than a pattern so
 * that a key added to `ProjectConfigSchema` tomorrow is refused until somebody
 * looks at it.
 *
 * `workspace` is here because it is the machine-wide `agents.workspace` asked
 * of one project, and that is `asked`: it decides where the next agent works,
 * which widens nothing an agent may do. `root` stays refused — moving it moves
 * every agent already in the project.
 */
const ALLOWED_UNDER: readonly RegExp[] = [
  /^projects\.[a-z0-9-]+\.brief$/,
  /^projects\.[a-z0-9-]+\.budget\./,
  /^projects\.[a-z0-9-]+\.checks\./,
  /^projects\.[a-z0-9-]+\.workspace$/,
  /^workers\.routes\.[a-z0-9-]+\.(model|thinking|harness)$/,
]

/** Whether `path` is `prefix` or lives under it. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`)
}

/**
 * How far the orchestrator may go with this setting, and why.
 *
 * Anything unnamed is `asked`, which is the safe default for an ordinary key
 * and would be the wrong one for a dangerous key — so nothing dangerous is a
 * lone key. Every one of them is a *subtree*, which is what makes a key added
 * to `approvals`, `extensions`, `mcp` or an account refused on the day it is
 * added, by somebody who never read this file. What a subtree cannot catch is
 * a whole new section of the config, and a test holds the list of those.
 */
export function settingReach(path: string): Reaches {
  if (OPEN.includes(path)) return { reach: 'open', because: '' }
  if (!ALLOWED_UNDER.some((allowed) => allowed.test(path))) {
    for (const [prefix, because] of NEVER) {
      if (under(path, prefix)) return { reach: 'never', because }
    }
  }
  return { reach: 'asked', because: '' }
}

/**
 * The words that identify one setting: what a person would have to say for a
 * line of theirs to be about it.
 *
 * Its dotted path, its title as a phrase, whatever it declared as keywords,
 * and the segments of its path long enough to mean something on their own —
 * five letters, which keeps `commit`, `thinking`, `harness`, `workspace` and
 * drops `mode`, `keys`, `stt`, `mic`.
 *
 * **The first segment never counts.** It is the section, and a section names
 * everything under it: with `agents` in, "how are the agents getting on" was
 * somebody asking for the commit rule to be changed. That is not hypothetical
 * — it is what the first run of this rule's own test did.
 *
 * The title always counts however short it is: it is the name the setting
 * actually has, and somebody who says it has named it. Which is also the shape
 * of the ordinary conversation here — the orchestrator says the setting back
 * by name, and they answer naming it.
 *
 * Known looseness, said rather than hidden: a leaf that is an ordinary word of
 * this house — `checks.before`, `telemetry.agents` — is matched by a line that
 * meant something else by it. An English stop list is the kind of thing that
 * rots, and what it would buy is bounded: everything that could widen what an
 * agent may do is in the tier no words reach at all, and what is left here can
 * only change when Tade runs checks unasked, or what it times.
 */
export function wordsFor(setting: Pick<Setting, 'path' | 'title' | 'keywords'>): string[] {
  const segments = setting.path
    .split('.')
    .slice(1)
    .filter((part) => part.length >= 5)
  return [setting.path, setting.title, ...(setting.keywords ?? []), ...segments]
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '')
}

/** Whether `phrase` appears in `line` on its own, rather than inside a longer word. */
function saidIn(line: string, phrase: string): boolean {
  let at = line.indexOf(phrase)
  while (at >= 0) {
    const before = line[at - 1]
    const after = line[at + phrase.length]
    const word = (char: string | undefined) => char !== undefined && /[a-z0-9]/.test(char)
    if (!word(before) && !word(after)) return true
    at = line.indexOf(phrase, at + 1)
  }
  return false
}

/**
 * The line of theirs that names this setting, or null when none does.
 *
 * The other half of `asked`, and the half that makes it a rule rather than a
 * promise: `lines` are the things the *person* said — typed or spoken, kept
 * verbatim in the journal — and text an agent read cannot ever get into them.
 * A page can tell a model to turn the checks off; it cannot put "turn the
 * checks off" in somebody's mouth.
 *
 * Honest about what it holds. It is a barrier and not a proof: an ordinary
 * word like `before` can match a line that meant something else, and somebody
 * who says "make the left bit wider" has named nothing and is refused. Both
 * are the safe direction — it can only ever refuse, never permit what the tier
 * did not already allow.
 */
export function namedBy(
  setting: Pick<Setting, 'path' | 'title' | 'keywords'>,
  lines: readonly string[],
): string | null {
  const words = wordsFor(setting)
  for (const line of lines) {
    const said = line.toLowerCase()
    if (words.some((word) => saidIn(said, word))) return line
  }
  return null
}

/** How many of the person's own lines are looked back over for one. */
export const LINES_LOOKED_BACK = 40
