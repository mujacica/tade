import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type EventType, type TadeEvent, typeNow } from './events.ts'

// Every machine's journal, held on every other machine of the person's: the
// rules, pure. The file work is `@tade/workbench`'s `feeds.ts`, the exchange's
// cadence the window's.
//
// **One writer per feed, so nothing to merge.** Each machine's `events.jsonl`
// stays the only truth about that machine, written by the one window holding
// its home. Every other machine keeps a read-only copy of it, apart from its
// own journal, under `<home>/machines/<id>/` — a cache of that machine's truth,
// labelled with whose it is, never a second truth about it. Because each feed
// has exactly one writer, the union of copies is a grow-only set: a line is
// fetched once and never changes, whichever machine relayed it.
//
// **Who a feed is, and which life of it.** A machine id, minted once in
// `<home>/machine.json` and kept across renames, and a journal epoch, minted
// when the journal is created and again by `tade host restore`: a restored
// journal numbers its lines again from where the backup was, so the numbers it
// hands out next have been handed out before, to other lines.
//
// **The cursor is `(machine, epoch, seq)`, and integrity a hash chain** over
// the lines a machine serves, `h_n = sha256(h_{n-1} ‖ line_n)`. Two copies
// that agree on `(epoch, seq, h)` hold the same lines; two that disagree at a
// number both hold are two histories of one machine — a fork, which is kept
// beside the other and said, never resolved by throwing one away.
//
// **What travels is an allow-list** (`FEED_TYPES`), so a kind of line nobody
// argued for stays where it was written. Never the samples compaction drops
// (`SAMPLED_TYPES`), so the origin's compaction never moves a copy's cursor:
// what it takes out was never served.
//
// **Folds over feeds read each feed by itself.** A `seq` means something only
// inside the file and epoch it came from, so anything comparing numbers — the
// queue above all — reads only this machine's own lines (`ownLines`), and a
// fold across machines labels each line with its machine and never adds up
// what each machine says by its own clock (spend, runtime).

/**
 * The kinds of line another machine is given. Every other kind is in
 * `STAYS_HERE` with why, and a test holds every type to one of the two, so a
 * new kind of line is a decision rather than a default.
 */
export const FEED_TYPES: readonly EventType[] = [
  'lane_opened',
  'lane_adopted',
  'lane_exited',
  'lane_closed',
  'task_created',
  'task_named',
  'task_removed',
  'task_moved',
  'task_taken',
  'task_handing',
  'effort_named',
  'template_used',
  'race_won',
  'replay_started',
  'replay_graded',
  'replay_stopped',
  'state_change',
  'task_done',
  'agent_closed',
  'document_ready',
  'document_triaged',
  'document_moved',
  'document_deleted',
  'context_added',
  'note_retired',
  'queue_started',
  'queue_held',
  'queue_changed',
  'conflict_forecast',
  'schedule_fired',
  'schedule_changed',
  'watch_found',
  'proposal_decided',
  'leftovers_reported',
  'intake_received',
  'intake_refused',
  'intake_accepted',
  'intake_held',
  'intake_replied',
  'run_started',
  'run_model',
  'run_exited',
  'permission_request',
  'permission_granted',
  'permission_denied',
  'turn_started',
  'turn_done',
  'failed',
  'agent_continued',
  'usage',
  'plan_said',
  'check_ran',
  'commit_seen',
  'ignore_written',
  'ignore_removed',
  'config_changed',
  'web_enabled',
  'web_paired',
  'web_denied',
  'web_revoked',
  'web_did',
  'web_asked',
  'web_subscribed',
  'remote_carried',
  'carried_in',
  'settings_conflict',
  'project_synced',
  'project_sync_held',
  'machine_seen',
  'inventory_changed',
  'machine_finding',
  'env_consolidated',
  'feed_forked',
  'said',
  'tade_opened',
  'tade_closing',
  'warning',
]

/** Every kind of line that is never given to another machine, and why. */
export const STAYS_HERE: Readonly<Partial<Record<EventType, string>>> = {
  output: 'a sample of a lane’s bytes, which compaction drops',
  input: 'a sample of what was typed, which compaction drops',
  reflected: 'trace: that this machine looked back over a task, which no other machine asks',
  tool_call: 'one per tool an agent calls: the volume of a lane, not its record',
  watch_checked: 'a look on a clock that found nothing; what one found is `watch_found`',
  hook_rung: 'a webhook arriving at this machine’s door, bounded per minute and nobody else’s',
  orchestrator_told: 'what this machine’s orchestrator was told, which its own conversation holds',
  orchestrator_compacted: 'this machine’s orchestrator’s conversation, compacted',
  journal_compacted: 'what this machine’s compaction did to its own file',
  web_refused: 'a stranger at this machine’s door',
  web_proved: 'the person proving it is them at this machine’s door, every few hours',
  web_pushed: 'a notification this machine sent, which the person has already seen',
  remote_linked:
    'this machine’s link to another, which that machine says of itself in `machine_seen`',
  remote_unlinked:
    'this machine’s link to another, which that machine says of itself in `machine_seen`',
  notes_shared: 'an exchange between two machines, which would be news about being copied',
  remote_synced: 'an exchange between two machines, which would be news about being copied',
  person_present: 'a cursor for what the person missed at this machine',
}

const TRAVELS: ReadonlySet<string> = new Set(FEED_TYPES)

/** Whether a kind of line is given to another machine. */
export function travels(type: string): boolean {
  // A line written under a kind's old name travels as that kind does.
  return TRAVELS.has(typeNow(type))
}

/** What a machine id looks like: a UUID, minted once (`machine.json`). */
export const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One life of a machine's journal: minted when it was created, and again by a restore. */
export interface Epoch {
  /** Sixteen hex digits. */
  id: string
  /** When it was minted, by that machine's clock: what orders two epochs of one machine. */
  at: string
}

/** What an epoch id looks like. */
export const EPOCH_ID = /^[0-9a-f]{16}$/

/** Whether a value is an epoch somebody could have minted. Anything else is not one. */
export function isEpoch(value: unknown): value is Epoch {
  const one = value as Partial<Epoch> | null
  return (
    typeof one?.id === 'string' &&
    EPOCH_ID.test(one.id) &&
    typeof one.at === 'string' &&
    Number.isFinite(Date.parse(one.at))
  )
}

/**
 * Which of two epochs of one machine is the later life: positive where `a`
 * is. By when each was minted, and by id where two were minted in the same
 * millisecond, so every machine comparing the same two picks the same one.
 */
export function laterEpoch(a: Epoch, b: Epoch): number {
  const at = Date.parse(a.at) - Date.parse(b.at)
  if (at !== 0) return at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Where every chain begins: the hash of no lines. */
export const CHAIN_START = '0'.repeat(64)

/** The chain one line on: `sha256(h ‖ line)`, the line exactly as the origin wrote it. */
export function chainNext(h: string, line: string): string {
  return createHash('sha256').update(h).update('\n').update(line).digest('hex')
}

/** What looks like a link of the chain. */
export const CHAIN_HASH = /^[0-9a-f]{64}$/

/** One feed as one machine holds it: whose, which life, how far, and the chain there. */
export interface FeedSummary {
  /** The machine id of the feed's origin. */
  machine: string
  /** What the origin calls itself (`machineLabel` there): what a line from it is labelled. */
  name: string
  epoch: Epoch
  /** The highest number held, nought for none. */
  seq: number
  /** How many lines are held. */
  n: number
  /** The chain at `seq`. */
  h: string
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** A line out of another machine's feed, labelled with what that machine calls itself. */
export type FleetEvent = TadeEvent & { machine: string }

/** Whether a line came out of another machine's feed rather than this one's journal. */
export function foreign(event: TadeEvent): event is FleetEvent {
  return typeof (event as Partial<FleetEvent>).machine === 'string'
}

/**
 * Only this machine's own lines. Anything that compares `seq` reads these and
 * nothing else: a number from another machine's journal is a number in another
 * file, and set beside this one's it orders nothing. Hands back the same array
 * where nothing foreign is in it, so the common case costs one pass and no copy.
 */
export function ownLines<T extends TadeEvent>(events: readonly T[]): readonly T[] {
  return events.some(foreign) ? events.filter((event) => !foreign(event)) : events
}

// ── Where two machines stand ─────────────────────────────────────────────────

/**
 * Everything one machine holds that another should, summed per channel: the
 * feeds, the notes (`sumOf` over their digests) and each kept setting's value
 * by digest, with what it pinned. Compared, it is the state hash; apart, it
 * says how far behind and where.
 */
export interface SyncSummary {
  feeds: FeedSummary[]
  /** The notes' sum (`@tade/workbench`'s `sumOf`): equal exactly when both hold the same lines. */
  notes: string
  /** Each kept setting's value as a digest (`settingDigest`), by path. Never a key. */
  settings: Readonly<Record<string, string>>
  /** What it keeps to itself (`machine.pinned`), which neither side compares. */
  pinned: readonly string[]
}

/** A kept setting's value as the state hash reads it: sixteen hex digits of its text. */
export function settingDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Whether a path is one of these pinned ones, or inside one. */
function pinnedAt(path: string, pinned: readonly string[]): boolean {
  return pinned.some((one) => path === one || path.startsWith(`${one}.`))
}

/**
 * The state hash of one machine, as compared with one other: sha256 over each
 * channel's summary. Settings either machine pinned are left out of both, so
 * two machines that agree on everything they share hash the same.
 */
export function stateHash(summary: SyncSummary, theirPinned: readonly string[] = []): string {
  const pinned = [...summary.pinned, ...theirPinned]
  const feeds = [...summary.feeds]
    .sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0))
    .map((one) => `${one.machine}:${one.epoch.id}:${one.seq}:${one.h}`)
  const settings = Object.entries(summary.settings)
    .filter(([path]) => !pinnedAt(path, pinned))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, digest]) => `${path}=${digest}`)
  const hash = createHash('sha256')
  hash.update(`feeds\n${feeds.join('\n')}\n`)
  hash.update(`notes\n${summary.notes}\n`)
  hash.update(`settings\n${settings.join('\n')}\n`)
  return hash.digest('hex')
}

/** The channels two summaries differ in. */
export type SyncChannel = 'feeds' | 'notes' | 'settings'

/** The word for where two machines stand. */
export type SyncWord = 'in step' | 'behind' | 'ahead' | 'apart'

/** Where this machine and another stand, as of one exchange. */
export interface SyncState {
  word: SyncWord
  /** This machine's state hash and the other's, each as compared with the other. */
  here: string
  there: string
  /** Lines the other holds that this one does not, and the other way. */
  behind: number
  ahead: number
  /** Feeds forked in this exchange. */
  forks: number
  /** Settings both changed apart, settled since the two were last in step. */
  conflicts: number
  /** What differs, where anything does. */
  differ: SyncChannel[]
  /** When, by this machine's clock. */
  at: number
}

/** How many lines `a` holds of a feed that `b` does not: by count, within one life. */
function linesBeyond(a: FeedSummary | undefined, b: FeedSummary | undefined): number {
  if (a === undefined) return 0
  if (b === undefined || laterEpoch(a.epoch, b.epoch) > 0) return a.n
  if (laterEpoch(a.epoch, b.epoch) < 0) return 0
  return Math.max(0, a.n - b.n)
}

/**
 * Where two machines stand, from each one's summary: `in step` exactly when
 * their state hashes are equal; otherwise `behind` where the other holds lines
 * this one does not, `ahead` the other way round, and `apart` where both or
 * neither — notes or settings that differ.
 */
export function syncStateOf(
  here: SyncSummary,
  there: SyncSummary,
  extra: { forks: number; conflicts: number; at: number },
): SyncState {
  const mine = stateHash(here, there.pinned)
  const theirs = stateHash(there, here.pinned)
  const byId = (list: readonly FeedSummary[]) => new Map(list.map((one) => [one.machine, one]))
  const ours = byId(here.feeds)
  const others = byId(there.feeds)
  let behind = 0
  let ahead = 0
  for (const id of new Set([...ours.keys(), ...others.keys()])) {
    behind += linesBeyond(others.get(id), ours.get(id))
    ahead += linesBeyond(ours.get(id), others.get(id))
  }
  const differ: SyncChannel[] = []
  const feedsSame =
    stateHash({ ...here, notes: '', settings: {} }) ===
    stateHash({ ...there, notes: '', settings: {} })
  if (!feedsSame) differ.push('feeds')
  if (here.notes !== there.notes) differ.push('notes')
  const pinned = [...here.pinned, ...there.pinned]
  const settingsOf = (s: SyncSummary) =>
    Object.entries(s.settings)
      .filter(([path]) => !pinnedAt(path, pinned))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .join('\n')
  if (settingsOf(here) !== settingsOf(there)) differ.push('settings')
  const word: SyncWord =
    mine === theirs
      ? 'in step'
      : behind > 0 && ahead === 0
        ? 'behind'
        : ahead > 0 && behind === 0
          ? 'ahead'
          : 'apart'
  return { word, here: mine, there: theirs, behind, ahead, differ, ...extra }
}

/**
 * Where two machines stand, in the words every screen uses: `in step`,
 * `behind by 3 lines`, `1 conflict`. A conflict is said first, because it is
 * the one a person may want to read back; a fork after it.
 */
export function syncSaid(
  state: Pick<SyncState, 'word' | 'behind' | 'ahead' | 'conflicts' | 'forks' | 'differ'>,
): string {
  const parts: string[] = []
  if (state.conflicts > 0)
    parts.push(`${state.conflicts} ${state.conflicts === 1 ? 'conflict' : 'conflicts'}`)
  if (state.forks > 0) parts.push(`${state.forks} ${state.forks === 1 ? 'fork' : 'forks'} kept`)
  if (state.word === 'in step') return ['in step', ...parts].join(' · ')
  const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`
  if (state.behind > 0) parts.push(`behind by ${lines(state.behind)}`)
  if (state.ahead > 0) parts.push(`ahead by ${lines(state.ahead)}`)
  const rest = state.differ.filter((one) => one !== 'feeds')
  if (rest.length > 0) parts.push(`${rest.join(' and ')} differ`)
  return parts.length > 0 ? parts.join(' · ') : 'not in step'
}

// ── Task names across the fleet ──────────────────────────────────────────────

/**
 * Every task name another machine's feed made, with which machine — except a
 * name that moved, which is one task travelling and not two: a feed where the
 * name was handed on (`task_moved`) or came from elsewhere (`task_taken`).
 * `from` is the machine a take comes from, whose own names are the task being
 * taken.
 */
export function namesElsewhere(lines: readonly FleetEvent[], from?: string): Map<string, string> {
  const made = new Map<string, string>()
  const moved = new Set<string>()
  for (const line of lines) {
    if (line.task === null) continue
    const key = `${line.machine}\n${line.task}`
    if (line.type === 'task_moved' || line.type === 'task_taken') moved.add(key)
    else if (line.type === 'task_created') made.set(key, line.machine)
  }
  const out = new Map<string, string>()
  for (const [key, machine] of made) {
    if (moved.has(key) || machine === from) continue
    out.set(key.slice(key.indexOf('\n') + 1), machine)
  }
  return out
}

// ── The exchange's body, as the far side's door reads it ─────────────────────

const NameText = z.string().max(120)

const IdText = z.string().regex(MACHINE_ID)

const EpochText = z.strictObject({
  id: z.string().regex(EPOCH_ID),
  at: z.string().max(40),
})

const HashText = z.string().regex(CHAIN_HASH)

const SeqText = z.int().nonnegative()

const SummaryText = z.strictObject({
  machine: IdText,
  name: NameText,
  epoch: EpochText,
  seq: SeqText,
  n: SeqText,
  h: HashText,
})

const GivenText = z.strictObject({
  machine: IdText,
  name: NameText,
  epoch: EpochText,
  after: SeqText,
  h: HashText,
  lines: z.array(z.string().max(64 * 1024)).max(2_000),
  piece: z
    .strictObject({ text: z.string().max(64 * 1024), from: SeqText, done: z.boolean() })
    .optional(),
})

const WantText = z.strictObject({ machine: IdText, epoch: EpochText, after: SeqText, h: HashText })

/**
 * What one request of an exchange may say (`@tade/web`'s `shared-feeds.ts`
 * reads every body through this before anything else does): here, beside the
 * rules, because its cursor is `(machine, epoch, seq)` with the chain at it —
 * safe across a compaction and a restore only because of the epoch and the
 * chain — and the away view's own package keys nothing to a journal's numbers.
 */
export const FeedsBody = z.strictObject({
  from: z.strictObject({ id: IdText, name: NameText }),
  have: z.array(SummaryText).max(64).optional(),
  sync: z
    .strictObject({
      notes: z.string().max(64),
      settings: z.record(z.string().max(200), z.string().max(64)),
      pinned: z.array(z.string().max(200)).max(500),
    })
    .optional(),
  close: z.boolean().optional(),
  give: z.array(GivenText).max(64),
  want: z.array(WantText).max(64),
})
