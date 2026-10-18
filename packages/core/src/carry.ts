import { createHash } from 'node:crypto'
import { TALKING_IS_NOT_YOU_SHORT } from './origin.ts'
import { heldSays, IN_CONFIG, SEEN_BY_AGENTS } from './secrets.ts'

// What another machine's Tade is given of this one's: the decision for every
// key, beside `settingReach` because it is the same kind of question — what a
// path is — and two answers to it in two places is how they come to disagree.
//
// A remote (`remotes.ts`) is a whole Tade with its own home. Somebody who set
// this one up should not have to set it up twice, so what can travel does,
// and what cannot is said with what to do instead. Four answers:
//
// - `kept`    — carried when a remote is added and kept in step after:
//               ordinary preferences, the attention settings, which
//               extensions are on, the personas and published templates.
//               Written there through that machine's own write path, as a
//               change somebody can read and undo, and **never over a value
//               that machine changed itself** (`carryDecision`).
// - `pressed` — carried on one press, never by itself: a key, an MCP server
//               (somebody else's code, with what it is handed), the
//               telemetry DSN, intake's grants. Each is `never` to the
//               orchestrator here, and sending one to a box on the internet is
//               a decision — so it is made where somebody is deciding, with
//               `KEYS_TO_REMOTE` said there.
// - `guided`  — never copied, and the person is walked through it: a
//               harness's own sign-in. A subscription token never passes
//               through Tade, so that machine signs in through the harness's
//               own flow, in a terminal the person can see. Not a config key
//               at all, which is why it is only in `HOME_HOLDS`.
// - `here`    — this machine's by nature: where projects live, which driver
//               holds the lanes, where agents work, the remotes, the away
//               view's door, this machine's microphone and speakers.
//
// **Unnamed is `here`.** A section added to the schema tomorrow stays on the
// machine it was set on until somebody decides otherwise — the safe direction
// for a key nobody has looked at, the way `asked` is for `settingReach` — and
// `test/carry.test.ts` fails until every section has been named here.

export type Carry = 'kept' | 'pressed' | 'here'

export interface Carries {
  carry: Carry
  /** Why, in one clause: what the checklist says beside it. Empty for `kept`. */
  because: string
  /** Carried as one value, never leaf by leaf: a table whose keys are names (`prices`). */
  whole?: true
}

interface Rule {
  /** A dotted prefix, or a pattern a path must match whole. */
  at: string | RegExp
  carry: Carry
  because: string
  whole?: true
  /** A leaf here named like a key is not one: the talk key is a key on a keyboard. */
  plain?: true
}

const MACHINE_DRIVER = 'which program holds the lanes is this machine’s: what it has installed'
const NOT_DECIDED =
  'nothing has decided whether this is carried, so it stays on the machine it was set on'

/**
 * Every decision, first match wins — so a longer path sits above the subtree it
 * lives in, as `NEVER` does in `reach.ts`.
 */
const RULES: readonly Rule[] = [
  // ── this machine's own ──
  { at: 'workspace', carry: 'here', because: MACHINE_DRIVER },
  { at: 'drivers', carry: 'here', because: MACHINE_DRIVER },
  {
    at: 'projects',
    carry: 'here',
    because: 'a project is a folder on this machine; the other one opens its own',
  },
  {
    at: 'remotes',
    carry: 'here',
    because: 'the machines this one drives, with a session that is yours there, are its own',
  },
  {
    at: 'backup',
    carry: 'here',
    because:
      'where this machine is backed up to, and the password its backup opens with, are its own',
  },
  {
    at: 'surfaces.web',
    carry: 'here',
    because: 'the away view is this machine’s door: who reaches it, at which names, which devices',
  },
  {
    at: 'agents.workspace',
    carry: 'here',
    because: 'where agents work is decided for the machine they work on',
  },
  { at: 'agents.keep_awake', carry: 'here', because: 'it holds this machine’s sleep off' },
  {
    at: 'agents.give_way',
    carry: 'here',
    because: 'it keeps agents below this machine’s own window',
  },
  {
    at: 'orchestrator.extensions',
    carry: 'here',
    because: 'it is a folder on this machine',
  },
  {
    at: 'surfaces.voice.stt',
    carry: 'here',
    because: 'how speech becomes text is this machine’s engine and its model files',
  },
  { at: 'surfaces.voice.mic', carry: 'here', because: 'it is this machine’s microphone' },
  { at: 'surfaces.voice.speak', carry: 'here', because: 'it is this machine’s speakers' },
  { at: 'surfaces.voice.muted', carry: 'here', because: 'it is this machine’s speakers' },
  {
    at: 'telemetry.environment',
    carry: 'here',
    because: 'it names which machine is reporting',
  },
  { at: 'journal', carry: 'here', because: 'what the journal may weigh is this machine’s disk' },
  {
    at: 'budget',
    carry: 'here',
    because:
      'what a machine may spend in a day is a cap on that machine’s night, set where it runs',
  },
  {
    at: 'checks.run_here',
    carry: 'here',
    because: 'which checks can run is a fact about this machine',
  },
  {
    at: 'checks.parallel',
    carry: 'here',
    because: 'how many run at once is this machine’s capacity',
  },
  {
    at: 'checks.suites',
    carry: 'here',
    because: 'how many run at once is this machine’s capacity',
  },
  {
    at: /^extensions\.intake\.github_app_(id|key|slug)$/,
    carry: 'here',
    because:
      'the GitHub App was made for this machine’s public name: its deliveries and its callbacks come here',
  },
  {
    at: /^extensions\.intake\.slack_client_(id|secret)$/,
    carry: 'here',
    because:
      'the Slack app was made for this machine’s public name: its events and its install come back here',
  },
  {
    at: /^extensions\.intake\.linear_(client_id|refresh_token)$/,
    carry: 'here',
    because:
      'the Linear app was made for this machine’s address, and its refresh token is good once: two machines refreshing one would each spend the other’s',
  },
  // ── on a press ──
  {
    at: 'telemetry.dsn',
    carry: 'pressed',
    because: 'it is where Tade sends its trouble from that machine',
  },
  {
    at: /^mcp\.servers\.[a-z0-9-]+$/,
    carry: 'pressed',
    whole: true,
    because: 'an MCP server is somebody else’s code, with whatever it is handed',
  },
  {
    at: 'mcp',
    carry: 'pressed',
    because: 'an MCP server is somebody else’s code, with whatever it is handed',
  },
  {
    at: 'surfaces.intake',
    carry: 'pressed',
    whole: true,
    because: 'intake is whose words can make work on that machine',
  },
  // ── kept in step ──
  { at: 'surfaces.voice.talk', carry: 'kept', because: '', plain: true },
  { at: 'surfaces.voice.attention', carry: 'kept', because: '' },
  { at: 'surfaces.search', carry: 'kept', because: '' },
  { at: 'surfaces.window', carry: 'kept', because: '' },
  { at: 'prices', carry: 'kept', because: '', whole: true },
  { at: 'orchestrator', carry: 'kept', because: '' },
  { at: 'workers', carry: 'kept', because: '' },
  { at: 'accounts', carry: 'kept', because: '' },
  { at: 'approvals', carry: 'kept', because: '' },
  { at: 'agents', carry: 'kept', because: '' },
  { at: 'telemetry', carry: 'kept', because: '' },
  { at: 'documents', carry: 'kept', because: '' },
  { at: 'notes', carry: 'kept', because: '' },
  { at: 'queue', carry: 'kept', because: '' },
  { at: 'checks', carry: 'kept', because: '' },
  { at: 'extensions', carry: 'kept', because: '' },
]

/** A key, wherever it is: the leaf names every credential Tade declares has (`isCredential`). */
const CREDENTIAL = /(?:^|_)(?:key|token|secret|password)$/

const A_KEY = 'it is a key'

function matches(path: string, at: string | RegExp): boolean {
  return typeof at === 'string' ? path === at || path.startsWith(`${at}.`) : at.test(path)
}

/**
 * Whether this setting goes to another machine's Tade, and how.
 *
 * `secret` is the caller's own word that the path is a credential — an
 * extension's declared one — for a key whose name does not say so. A key is
 * never carried by itself, whatever section it is in.
 */
export function carryOf(path: string, secret = false): Carries {
  const rule = RULES.find((one) => matches(path, one.at))
  if (rule === undefined) return { carry: 'here', because: NOT_DECIDED }
  if (rule.carry === 'kept' && !rule.plain) {
    const leaf = path.split('.').at(-1) ?? ''
    if (secret || CREDENTIAL.test(leaf)) return { carry: 'pressed', because: A_KEY }
  }
  return {
    carry: rule.carry,
    because: rule.because,
    ...(rule.whole ? { whole: true as const } : {}),
  }
}

/** The config's sections, as `carryOf` names them: what `test/carry.test.ts` holds. */
export const CARRY_SECTIONS: readonly string[] = [
  ...new Set(RULES.flatMap((one) => (typeof one.at === 'string' ? [one.at.split('.')[0]] : []))),
].filter((one): one is string => one !== undefined)

/** One value of this machine's config, as it would be carried. */
export interface CarryLeaf {
  path: string
  value: unknown
  carry: Carry
  because: string
}

/**
 * What this machine's config says, as values to carry: only what somebody
 * wrote — never a default, which the other machine has of its own — cut at
 * the places `carryOf` says are one value, and each with its decision.
 *
 * `written` is the file as parsed, not the schema's answer. A name with a dot
 * in it cannot be a path, so the table it is in is carried whole (`prices`);
 * one anywhere else is `here` and says why rather than being dropped.
 */
export function leavesOf(written: unknown, secrets: ReadonlySet<string> = new Set()): CarryLeaf[] {
  const leaves: CarryLeaf[] = []
  const walk = (value: unknown, at: string[]) => {
    if (value === null || value === undefined) return
    const path = at.join('.')
    if (at.length > 0) {
      if (at.some((part) => part.includes('.') || part === '')) {
        leaves.push({ path, value, carry: 'here', because: 'its name has a dot in it' })
        return
      }
      const decided = carryOf(path, secrets.has(path))
      const plainObject = typeof value === 'object' && !Array.isArray(value)
      if (decided.whole || !plainObject || isHereWhole(path)) {
        leaves.push({ path, value, carry: decided.carry, because: decided.because })
        return
      }
    }
    if (typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      walk(inner, [...at, key])
    }
  }
  walk(written, [])
  return leaves
}

/** A `here` rule at exactly this path: the whole subtree is this machine's, so it is one row. */
function isHereWhole(path: string): boolean {
  return RULES.some((one) => one.carry === 'here' && typeof one.at === 'string' && one.at === path)
}

/** The value at a dotted path of what was written, or undefined. */
export function writtenAt(written: unknown, path: string): unknown {
  let at: unknown = written
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at === null ? undefined : at
}

/**
 * A value as text, the same however its keys were ordered: what two machines
 * compare, and what `config_changed` says a carried setting was set to.
 */
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(sorted(value))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sorted(inner)]),
  )
}

/** What a key is compared by, where the key itself must not travel: its hash. */
export function keyDigest(value: unknown): string {
  return createHash('sha256').update(textOf(value)).digest('hex')
}

/** What happened to one carried thing there. */
export type CarryOutcome =
  /** Written there, through that machine's own write path. */
  | 'written'
  /** Written there over a different one, on a press. */
  | 'replaced'
  /** It was already so. */
  | 'same'
  /** That machine changed it itself, so it was left — and said. */
  | 'theirs'
  /** Not sent, because it waits on a press. */
  | 'waiting'
  /** That machine would not take it: `here` there, or it would not load. */
  | 'refused'

/** The last line that machine wrote about one path, as much as deciding needs. */
export interface LastChange {
  /** What it was set to, as `textOf` says it. */
  now: string
  /** Whether a carry wrote it, rather than somebody there. */
  carried: boolean
}

/**
 * Whether that machine changed a value itself: the one question that decides
 * whether a carry may write over it.
 *
 * Read off what is there and the last line its journal wrote about the path,
 * never off a memory of what was sent:
 *
 * - **The last line is somebody there** — the Settings page, the
 *   orchestrator, a device — so it is theirs, whatever it says now.
 * - **The last line is a carry, and the file says something else** — it was
 *   edited by hand since — so it is theirs.
 * - **No line at all, and something is written** — by hand, or before
 *   anything wrote lines — so it is theirs. Nothing written is nobody's.
 */
export function changedThere(current: unknown, last: LastChange | null): boolean {
  if (last === null) return current !== undefined && current !== null
  if (!last.carried) return true
  return textOf(current) !== last.now
}

/**
 * What a carry does with one setting there. Pure: what is there, what came,
 * the last line about it, and whether the person pressed for theirs to go.
 */
export function carryDecision(req: {
  carry: Carry
  /** What came: a value, `null` to take one away, or only a digest to compare. */
  incoming: { value: unknown } | { digest: string }
  current: unknown
  last: LastChange | null
  /** The person pressed for this machine's value to go over theirs. */
  force: boolean
}): CarryOutcome {
  if (req.carry === 'here') return 'refused'
  const there = req.current === null ? undefined : req.current
  if ('digest' in req.incoming) {
    return there !== undefined && keyDigest(there) === req.incoming.digest ? 'same' : 'waiting'
  }
  const value = req.incoming.value === null ? undefined : req.incoming.value
  if (textOf(there) === textOf(value)) return 'same'
  // A press is the decision: the person was told it replaces what is there.
  if (req.carry === 'pressed') return there === undefined ? 'written' : 'replaced'
  if (!req.force && changedThere(there, req.last)) return 'theirs'
  return 'written'
}

/**
 * What one carried write says it set, on the `config_changed` line that
 * machine writes: the value as text for a preference, and for anything carried
 * on a press — a key, or a block a key may be inside — only whether there is
 * one (`heldSays`), as every other writer says a key.
 */
export function carriedSays(carry: Carry, value: unknown): string {
  if (carry === 'pressed') return heldSays(value)
  if (value === undefined || value === null) return ''
  return textOf(value)
}

/**
 * What is said where somebody is about to send keys to another machine.
 *
 * `KEYS_AND_AGENTS` again, one machine further — its clause, never a second
 * wording of it: on that machine too the file is read by every agent, and that
 * machine may be on the internet. The way out in the same breath, because that
 * is the rule for every sentence of this kind.
 */
export const KEYS_TO_REMOTE =
  `Sends these to that machine’s ${IN_CONFIG}, written 0600 there and replacing any of the same ` +
  `name — and there too ${SEEN_BY_AGENTS}: agents run as you, and nothing sandboxes them. That ` +
  'they were sent, and by whom, is written down on both machines; a key never is. To keep one off ' +
  'that machine, export its variable there instead, or leave it unsent.'

/**
 * Talking to that machine's orchestrator from another screen — this one's tab
 * for it, and a phone paired there — which is that machine's own setting
 * (`surfaces.web` is `here`), so it is never carried and never sent by itself.
 *
 * It is turned on there on the person's press, from `tade remote add` and
 * Settings › Remotes, and only ever on: a press is an owner's, the SSH key's
 * word, so it is no wider than editing that machine's config over ssh, and off
 * is that machine's own Settings › Away view. Never the orchestrator's — the
 * whole of `surfaces.web` is `never` to it — and never a carry by itself.
 */
export const TALK_THERE = 'surfaces.web.orchestrator'

/** What is said where somebody is about to turn `TALK_THERE` on over there. */
export const TALK_TO_REMOTE =
  'Turns on Talk to Tade on that machine: what you type in its tab here goes to its orchestrator as ' +
  `you at its keyboard, and a device paired there and granted it may send one too — ${TALKING_IS_NOT_YOU_SHORT}. ` +
  'Its Settings › Away view turns it off again.'

/**
 * Everything a Tade home holds, and what becomes of each when a remote is
 * added: the inventory `tade remote add`'s checklist and Settings › Remotes
 * read, and the table the `add-config-key` recipe carries.
 */
export const HOME_HOLDS: readonly {
  what: string
  carry: Carry | 'guided'
  how: string
}[] = [
  {
    what: 'preferences',
    carry: 'kept',
    how: 'carried, and kept in step; a value changed there is left and said',
  },
  { what: 'attention settings', carry: 'kept', how: 'carried with the preferences' },
  {
    what: 'which extensions are on',
    carry: 'kept',
    how: 'carried; an extension of your own is code, and goes there the way code does',
  },
  {
    what: 'personas',
    carry: 'kept',
    how: 'the ones you wrote, carried; one changed there is left and said',
  },
  {
    what: 'published templates',
    carry: 'kept',
    how: 'carried: a published version never changes, so it is the same file there',
  },
  { what: 'keys', carry: 'pressed', how: 'sent on a press, never by themselves' },
  { what: 'MCP servers', carry: 'pressed', how: 'sent on a press: each is code with a key' },
  { what: 'the telemetry DSN', carry: 'pressed', how: 'sent on a press' },
  { what: 'intake’s grants', carry: 'pressed', how: 'sent on a press' },
  {
    what: 'harness sign-ins',
    carry: 'guided',
    how: 'never copied: each harness signs in there through its own sign-in, in a terminal you see',
  },
  {
    what: 'projects, drivers, where agents work, remotes, the away view, voice hardware',
    carry: 'here',
    how: 'each machine’s own',
  },
  {
    what: 'notes, the journal, tasks, skills Tade learned, paired devices',
    carry: 'here',
    how: 'each machine’s own record',
  },
]
