import { createHash } from 'node:crypto'
import { compareStamps, lineStamp, type Stamp, stampOf, stampText } from './hlc.ts'
import { TALKING_IS_NOT_YOU_SHORT } from './origin.ts'
import { settingReach } from './reach.ts'
import { heldSays, IN_CONFIG, SEEN_BY_AGENTS } from './secrets.ts'

// What another machine's Tade is given of this one's: the decision for every
// key, beside `settingReach` because it is the same kind of question — what a
// path is — and two answers to it in two places is how they come to disagree.
//
// A remote (`remotes.ts`) is a whole Tade with its own home. Somebody who set
// this one up should not have to set it up twice, so what can travel does,
// and what cannot is said with what to do instead. Four answers:
//
// - `kept`    — kept in step both ways: ordinary preferences, the attention
//               settings, which extensions are on, the personas and
//               published templates. Each setting is a register whose last
//               writer wins (`settle`), by the hybrid-clock stamp on its
//               `config_changed` line (`hlc.ts`), written on each machine
//               through its own write path as a change somebody can read and
//               undo. The value that lost is written down and said
//               (`settings_conflict`) where both machines had changed it
//               without seeing the other's. A machine may keep one as its
//               own (`machine.pinned`), and a peer's change to what widens
//               agents (`never` to the orchestrator) lands only where the
//               person made it (`peerMayWrite`).
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
  {
    at: 'machine',
    carry: 'here',
    because: 'what this machine keeps to itself is decided on this machine',
  },
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
  /** A file that machine changed itself, so it was left — and said. */
  | 'theirs'
  /** A setting changed there later than here: theirs stands, and comes back with the answer. */
  | 'newer'
  /** A setting that machine keeps as its own (`machine.pinned`), so neither is taken. */
  | 'pinned'
  /** Not sent, because it waits on a press. */
  | 'waiting'
  /** That machine would not take it: `here` there, not the person's, or it would not load. */
  | 'refused'

/**
 * What two machines exchanging settings speak: a Tade that speaks another
 * refuses rather than guesses. 1 was the one-way carry, where the receiver
 * left whatever it had changed itself; 2 is both ways, every kept setting a
 * register with a stamp. An older Tade parsing a newer one's carry would read
 * stamps it does not know as values it does, so it is refused and said, never
 * half taken (`@tade/web`'s `carried.ts`, `@tade/workbench`'s `carryTo`).
 */
export const CARRY_SCHEMA = 2

/** The last line that machine wrote about one path, as much as deciding needs. */
export interface LastChange {
  /** What it was set to, as `textOf` says it. */
  now: string
  /** Whether a carry wrote it, rather than somebody there. */
  carried: boolean
}

/**
 * What a carry compares once both ends have it: a key, by its digest, and
 * this machine's own, refused. A key goes only on a press — and the press is
 * the decision, because the person was told it replaces what is there.
 */
export function carryDecision(req: {
  carry: Exclude<Carry, 'kept'>
  /** What came: a value, `null` to take one away, or only a digest to compare. */
  incoming: { value: unknown } | { digest: string }
  current: unknown
}): CarryOutcome {
  if (req.carry === 'here') return 'refused'
  const there = req.current === null ? undefined : req.current
  if ('digest' in req.incoming) {
    return there !== undefined && keyDigest(there) === req.incoming.digest ? 'same' : 'waiting'
  }
  const value = req.incoming.value === null ? undefined : req.incoming.value
  if (textOf(there) === textOf(value)) return 'same'
  return there === undefined ? 'written' : 'replaced'
}

/**
 * One kept setting on one machine: its value, and the newest line about it —
 * when (`stamp`), what the writer held when it changed it (`over`), and who
 * changed it first, passed on from machine to machine (`by`).
 */
export interface Register {
  /** Undefined where nothing is set: taking one away is a change like any other. */
  value: unknown
  /** Null where no line says when: a value from before lines, earlier than any change. */
  stamp: Stamp | null
  over: Stamp | null
  by: string | null
}

/** Whose value stands, and whether both had changed it without seeing the other's. */
export interface Settled {
  keep: 'same' | 'here' | 'incoming'
  conflict: boolean
}

/**
 * Last writer wins: the later stamp's value stands on both machines, and two
 * machines settling the same pair always agree — a tie of stamps (two values
 * nobody wrote a line for) goes to the value that sorts later.
 *
 * **A conflict is two changes neither saw**: the winner was made over a stamp
 * earlier than the loser's (`over`), so the loser was a change of its own and
 * not simply behind. A machine catching up on what it missed is not one.
 */
export function settle(here: Register, incoming: Register): Settled {
  if (textOf(here.value) === textOf(incoming.value)) return { keep: 'same', conflict: false }
  let order = compareStamps(incoming.stamp, here.stamp)
  if (order === 0) order = textOf(incoming.value) > textOf(here.value) ? 1 : -1
  const [won, lost] = order > 0 ? [incoming, here] : [here, incoming]
  // A value nobody set, with no line about it, is not a change that lost.
  const nothing = lost.stamp === null && textOf(lost.value) === ''
  return {
    keep: order > 0 ? 'incoming' : 'here',
    conflict: !nothing && compareStamps(won.over, lost.stamp) < 0,
  }
}

/** Whether a line at one path is about a setting at the other: the same, inside it, or around it. */
export function pathsMeet(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

/**
 * The newest `config_changed` line about one path here, out of the journal's
 * fold: one written at the path, at a block around it (an account written
 * whole) or inside it (a model's price in `prices`), whichever is latest.
 */
export function registerAt(path: string, value: unknown, changes: readonly ChangeSeen[]): Register {
  let newest: ChangeSeen | null = null
  for (const one of changes) {
    if (!pathsMeet(one.path, path)) continue
    if (newest === null || compareStamps(one.stamp, newest.stamp) > 0) newest = one
  }
  // A value no line was ever written about was written into the file — by
  // hand, or before lines — which is somebody at the machine, never the
  // orchestrator: every one of its changes is a line.
  return {
    value: value === null ? undefined : value,
    stamp: newest?.stamp ?? null,
    over: newest?.over ?? null,
    by: newest === null ? 'file' : newest.by,
  }
}

/**
 * Whether the file says something other than the newest line written at a
 * path, so it was edited by hand since: there where the line took it away, or
 * gone where it set one — or, for a carry's line, which says the value as
 * `textOf` does, anything else. A line written here says it as it was typed,
 * so only whether there is one is compared. No line is no news: a value
 * nobody wrote one for is one from before lines.
 */
export function editedSince(current: unknown, last: LastChange | null): boolean {
  if (last === null) return false
  const there = textOf(current) !== ''
  if (there !== (last.now !== '')) return true
  return last.carried && textOf(current) !== last.now
}

/** Who changed a setting, as a carry passes it on: the line's own `by`, or for a carried one, its `origin`. */
export function whoChanged(detail: Readonly<Record<string, unknown>> | undefined): string | null {
  if (typeof detail?.carried === 'string') {
    return typeof detail.origin === 'string' ? detail.origin : null
  }
  return typeof detail?.by === 'string' ? detail.by : null
}

/**
 * Who is the person, as a line says who changed something: the window's own
 * Settings, a terminal's `tade config`, an edit to the file found by a carry,
 * and a device — which only reaches past `open` when it is theirs, with full
 * access (`web-settings.ts`). Never `orchestrator`, never Tade itself, never a
 * line that does not say.
 */
const THE_PERSON: ReadonlySet<string> = new Set(['window', 'you', 'cli', 'file'])

export function personBy(by: string | null): boolean {
  return by !== null && (THE_PERSON.has(by) || /^device [^\s]+$/.test(by))
}

/**
 * Whether another machine's change at this path may land here. A `never`
 * path widens what agents may do on the machine it lands on — approvals,
 * accounts, which extensions are on, a route's provider — so a peer's change
 * to one lands only where the person made it, and is said where it does
 * (3.4 of the shared-brain plan, Q3: applied and said, never waiting on a
 * press, which would take the phone's "do everything" away).
 */
export function peerMayWrite(path: string, by: string | null): boolean {
  return settingReach(path).reach !== 'never' || personBy(by)
}

/** Why a peer's change was not taken here, in one clause. */
export function notThePersonSays(by: string | null, from: string): string {
  const who = by === null ? 'nothing says who' : by === 'orchestrator' ? 'its orchestrator' : by
  return `what agents may do here changes only on your word, and on ${from} ${who} changed it`
}

/** Whether `machine.pinned` keeps this path to this machine: names it, a section it is in, or a part of it. */
export function pinnedHere(path: string, pinned: readonly string[]): boolean {
  return pinned.some((one) => pathsMeet(path, one.replace(/\.\*$/, '')))
}

/** One value that lost, as both machines write it down and say it. */
export interface SettingConflict {
  path: string
  kept: { value: string; machine: string; at: Stamp | null }
  lost: { value: string; machine: string; at: Stamp | null }
}

/**
 * The conflict as said, once, on each machine: "approvals.mode: vps set ask
 * at 14:02, mac set auto at 14:05; mac's kept". `hm` is the clock face of a
 * stamp, the caller's, so this stays pure.
 */
export function conflictSays(c: SettingConflict, hm: (wall: number) => string): string {
  const one = (side: SettingConflict['kept']) =>
    `${side.machine} set ${side.value === '' ? 'nothing' : side.value} ${side.at === null ? 'before anything wrote it down' : `at ${hm(side.at.wall)}`}`
  return `${c.path}: ${one(c.lost)}, ${one(c.kept)}; ${c.kept.machine}’s kept.`
}

/**
 * The `settings_conflict` line one machine writes: the path, whose value
 * stood and whose lost, each with its stamp, and the machine it was settled
 * with. Never a key: only kept settings are registers.
 */
export function conflictDetail(c: SettingConflict, other: string): Record<string, string> {
  return {
    path: c.path,
    with: other,
    kept: c.kept.value,
    kept_by: c.kept.machine,
    kept_at: c.kept.at === null ? '' : stampText(c.kept.at),
    lost: c.lost.value,
    lost_by: c.lost.machine,
    lost_at: c.lost.at === null ? '' : stampText(c.lost.at),
  }
}

/** A value as a conflict says it: one line, cut. */
export function shownValue(value: unknown): string {
  const text = textOf(value).replace(/\s+/g, ' ')
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/** A journal line, as much of one as the folds below read. */
export interface CarryLine {
  type: string
  /** When it was written, as the journal stamps it. */
  ts?: string
  detail?: Readonly<Record<string, unknown>>
}

/** The last line this machine wrote about one path, with when and by whom. */
export interface ChangeSeen extends LastChange {
  path: string
  /** The device whose carry wrote it, or null for anything else. */
  device: string | null
  /** When the line was written, in this machine's clock; null where it does not say. */
  at: number | null
  /** Its stamp (`hlc.ts`), or for a line from before stamps, its wall time. */
  stamp: Stamp | null
  /** The stamp this machine held for the path when it was changed. */
  over: Stamp | null
  /** Who changed it first (`whoChanged`). */
  by: string | null
}

/** The device a `by` names, where it names one: `device <id>`. */
function deviceIn(by: unknown): string | null {
  return typeof by === 'string' && by.startsWith('device ') ? by.slice('device '.length) : null
}

/**
 * The newest `config_changed` line per path, folded out of the journal —
 * what every register here is read from (`registerAt`). A carry's own line
 * says `carried`, which is what tells it from everyone else's.
 */
export function changesIn(lines: readonly CarryLine[]): ChangeSeen[] {
  const newest = new Map<string, ChangeSeen>()
  for (const line of lines) {
    if (line.type !== 'config_changed') continue
    const path = line.detail?.path
    if (typeof path !== 'string' || path === '') continue
    const carried = typeof line.detail?.carried === 'string'
    const at = line.ts === undefined ? Number.NaN : Date.parse(line.ts)
    newest.set(path, {
      path,
      now: typeof line.detail?.now === 'string' ? line.detail.now : String(line.detail?.now ?? ''),
      carried,
      device: carried ? deviceIn(line.detail?.by) : null,
      at: Number.isNaN(at) ? null : at,
      stamp: lineStamp(line.detail, line.ts),
      over: stampOf(line.detail?.over),
      by: whoChanged(line.detail),
    })
  }
  return [...newest.values()]
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
    how: 'kept in step both ways: the latest change on either stands, two made apart are said, and a setting either pins stays its own',
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
    what: 'notes',
    carry: 'kept',
    how: 'shared both ways while the link is up: each machine holds every linked one’s, and one retired on either is retired on both',
  },
  {
    what: 'the journal',
    carry: 'kept',
    how: 'each machine’s own record, and a read-only copy of it kept on every other, apart from theirs',
  },
  {
    what: 'tasks, skills Tade learned, paired devices',
    carry: 'here',
    how: 'each machine’s own record',
  },
]

/** A hand edit found where a carry looked: what its line said, and what the file says now. */
export interface HandEdit {
  path: string
  was: string
  now: string
}

/** This machine's `machine.pinned`, as written. */
export function pinnedIn(written: unknown): string[] {
  const pinned = writtenAt(written, 'machine.pinned')
  return Array.isArray(pinned) ? pinned.filter((one): one is string => typeof one === 'string') : []
}

/**
 * Every kept setting here as a register: each value written, cut where
 * `carryOf` says it is one value, and each one taken away — a line about a
 * kept path with nothing written there now — so taking one away travels as a
 * change. Never a key, never this machine's own, never what it pinned.
 */
export function registersHere(
  written: unknown,
  changes: readonly ChangeSeen[],
  secrets: ReadonlySet<string>,
): Map<string, Register> {
  const pinned = pinnedIn(written)
  const registers = new Map<string, Register>()
  for (const leaf of leavesOf(written, secrets)) {
    if (leaf.carry !== 'kept' || pinnedHere(leaf.path, pinned)) continue
    registers.set(leaf.path, registerAt(leaf.path, leaf.value, changes))
  }
  for (const change of changes) {
    if (writtenAt(written, change.path) !== undefined) continue
    if (carryOf(change.path, secrets.has(change.path)).carry !== 'kept') continue
    if (pinnedHere(change.path, pinned)) continue
    if ([...registers.keys()].some((path) => pathsMeet(path, change.path))) continue
    registers.set(change.path, registerAt(change.path, undefined, changes))
  }
  return registers
}

/**
 * Settings edited by hand since their newest line (`editedSince`): kept ones
 * only, because only a register needs to know when it was changed.
 */
export function handEdits(
  written: unknown,
  changes: readonly ChangeSeen[],
  secrets: ReadonlySet<string>,
): HandEdit[] {
  const edits: HandEdit[] = []
  for (const change of changes) {
    if (carryOf(change.path, secrets.has(change.path)).carry !== 'kept') continue
    const current = writtenAt(written, change.path)
    if (!editedSince(current, change)) continue
    edits.push({ path: change.path, was: change.now, now: textOf(current) })
  }
  return edits
}
