// The devices page's pure half: what kind of thing a device is, how this one
// reaches the machine, what it was granted as a matrix, every device in the
// order the list draws them, the session as a share of its length, and what
// this device itself said to Tade.
//
// **Nothing here widens what a device is told.** Another device arrives from
// `/api/devices` as a label and the moment it was paired — no address, no
// grant, no activity (`listing` in `src/devices.ts` says why) — so that is all
// this module ever says about one. Everything else on the page is about *this*
// device, out of its own session, its own address bar and the conversation it
// was already granted.
//
// No DOM and no clock: `asOf` is handed in. Held by `test/devices-client.test.ts`.

import { TROUBLES } from '../trouble.js'

/** A day, which is the unit a pairing and a session are counted in. */
export const DAY = 24 * 60 * 60_000

/**
 * How long a session lasts from its last renewal: `SESSION_MS` in
 * `src/sessions.ts`, copied because a browser cannot import a `.ts` file and
 * held equal by the test. A session slides, so this is what a full one is.
 */
export const SESSION_MS = 30 * DAY

/** A device paired this recently, that is not this one, is marked new. */
export const NEW_FOR = DAY

/** How many lines of what this device said the page shows before counting the rest. */
export const RECENT = 5

/**
 * The kinds a device is drawn as, each an icon from the sprite and a word.
 *
 * **A guess from a name somebody typed**, and drawn as one: the label is the
 * phone's own suggestion (`deviceWord` on the pairing screen) or whatever
 * replaced it, so the kind is a drawing hint and never a claim about the
 * hardware. A name nothing recognises is a *device*, not a phone.
 */
export const KINDS = {
  phone: { icon: 'devices', word: 'phone' },
  tablet: { icon: 'devices', word: 'tablet' },
  computer: { icon: 'laptop', word: 'computer' },
  device: { icon: 'devices', word: 'device' },
}

/** What kind of device a label names, as a key of `KINDS`. A tablet is asked first: *Android tablet*. */
export function kindOf(label) {
  const said = String(label ?? '').toLowerCase()
  if (/ipad|tablet|\btab\b/.test(said)) return 'tablet'
  if (/iphone|phone|android|pixel|galaxy|mobile/.test(said)) return 'phone'
  if (/\bmac|\bpc\b|windows|chromebook|linux|laptop|desktop|computer|workstation/.test(said)) {
    return 'computer'
  }
  return 'device'
}

/* ── how this device reaches the machine ───────────────────────────────────── */

const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^fd7a:115c:a1e0:/i
const NEAR =
  /^(10\.|192\.168\.|169\.254\.)|^172\.(1[6-9]|2\d|3[01])\.|^f[cde][0-9a-f]{2}:|\.local$|\.lan$|\.home\.arpa$/i

/**
 * Where this device reaches Tade, out of its own address bar.
 *
 * The page cannot know the address a device connects *from* — the machine
 * keeps that and never sends it — but it knows the address it connects *to*,
 * which is the same answer the window's `whereFrom` gives in words: this
 * machine, Tailscale, your network, or a name. `plain` is the one case worth
 * marking: plain HTTP across a network, which anybody on it can read.
 */
export function reachOf(hostname, protocol) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[|]$/g, '')
  const https = protocol === 'https:'
  const kind =
    host === ''
      ? 'unknown'
      : host === 'localhost' ||
          host.endsWith('.localhost') ||
          host === '::1' ||
          /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        ? 'machine'
        : TAILSCALE.test(host) || host.endsWith('.ts.net')
          ? 'tailscale'
          : NEAR.test(host)
            ? 'network'
            : 'named'
  const word =
    kind === 'machine'
      ? 'this machine'
      : kind === 'tailscale'
        ? 'Tailscale'
        : kind === 'network'
          ? 'your network'
          : kind === 'named'
            ? host
            : null
  const plain = !https && kind !== 'machine' && kind !== 'unknown'
  const under = https
    ? 'https'
    : kind === 'machine'
      ? 'loopback'
      : plain
        ? 'plain HTTP — readable on this network'
        : null
  return { kind, word, under, plain }
}

/* ── what this device was granted ──────────────────────────────────────────── */

/** The floor every device reads, granted by pairing and never taken away. */
export const FLOOR = { key: 'names', word: 'Names and counts' }

/**
 * Every reading grant, in `GRANTS`' own order (`store.js`, held equal by the
 * test), in the words a person would look for — a name each, never the
 * sentence `GRANT_MEANS` says where somebody is deciding.
 */
export const READS = [
  { key: 'titles', word: 'Work titles' },
  { key: 'intent', word: 'What you asked for' },
  { key: 'notes', word: 'Notes' },
  { key: 'findings', word: 'Findings' },
  { key: 'spend', word: 'Spend' },
  { key: 'reviews', word: 'Review links' },
  { key: 'accounts', word: 'Sign-ins' },
  { key: 'talk', word: 'Conversation' },
  { key: 'requests', word: 'Request titles' },
  { key: 'material', word: 'Request text' },
  { key: 'workflows', word: 'Workflows' },
  { key: 'lanes', word: 'Agent screens' },
  { key: 'settings', word: 'Settings' },
]

/**
 * Every scope beyond reading, each with the verbs it is the door for — the
 * scopes `SCOPES` (`surface.ts`) lists after `read`, held equal by the test.
 * `read` is not a cell: a paired device has it, and it is the floor above.
 */
export const DOES = [
  { key: 'answer', word: 'Answer', under: 'approvals, requests' },
  { key: 'steer', word: 'Steer', under: 'park, queue, finish, note' },
  { key: 'ask', word: 'Talk to Tade', under: 'send messages' },
  { key: 'agents', word: 'Stop agents', under: 'and reopen' },
  { key: 'projects', word: 'Close projects', under: 'and reopen' },
  { key: 'draft', word: 'Save drafts', under: 'of workflows' },
  { key: 'configure', word: 'Change settings', under: 'a few, from away' },
]

/**
 * The matrix: every reading and every doing, each on or off, and how many of
 * each are on — or null with no session to read it from.
 *
 * Off is drawn as well as on, because a grant that is simply absent from a
 * list cannot be told from one this page forgot to draw. A word the session
 * carries that this table does not name is left out, never drawn as a cell
 * nobody can explain — the machine drops one too (`reachOf`).
 */
export function matrixOf(you) {
  if (you === null || you === undefined) return null
  const reads = new Set(Array.isArray(you.reads) ? you.reads : [])
  const scopes = new Set(Array.isArray(you.scopes) ? you.scopes : [])
  const read = [
    { ...FLOOR, under: null, on: true, floor: true },
    ...READS.map((one) => ({ ...one, under: null, on: reads.has(one.key), floor: false })),
  ]
  const does = DOES.map((one) => ({ ...one, on: scopes.has(one.key), floor: false }))
  const on = (cells) => cells.filter((one) => one.on).length
  return {
    read,
    does,
    readOn: on(read),
    doOn: on(does),
    readSaid: `${on(read)} of ${read.length}`,
    doSaid: on(does) === 0 ? 'read only' : `${on(does)} of ${does.length}`,
  }
}

/* ── ages and moments ──────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A moment as a day, the year only where it is not this one's: `Oct 8`, `Jan 2 2025`. */
export function daySaid(at, asOf) {
  const when = new Date(at)
  if (at === null || at === undefined || Number.isNaN(when.getTime())) return null
  const year = when.getFullYear() === new Date(asOf).getFullYear() ? '' : ` ${when.getFullYear()}`
  return `${MONTHS[when.getMonth()]} ${when.getDate()}${year}`
}

/** A moment as a day and a time: `Oct 8, 09:05`. */
export function dateSaid(at, asOf) {
  const day = daySaid(at, asOf)
  if (day === null) return null
  const when = new Date(at)
  const two = (n) => String(n).padStart(2, '0')
  return `${day}, ${two(when.getHours())}:${two(when.getMinutes())}`
}

/** How long ago, in its one largest unit: `now`, `12m`, `4h`, `3d`. Null for no moment. */
export function agoSaid(at, asOf) {
  const was = typeof at === 'number' ? at : Date.parse(at ?? '')
  if (Number.isNaN(was)) return null
  const ms = Math.max(0, asOf - was)
  if (ms < 60_000) return 'now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / DAY)}d`
}

/* ── the session ───────────────────────────────────────────────────────────── */

/**
 * The session as a gauge: what is left of a full one, the figure in its one
 * largest unit, how worried to be — `tight` under a day, `warm` under a week —
 * and when it ends, as a moment and as a day. Null where there is no moment
 * to count to.
 *
 * A session renews as it is used (`RENEW_AFTER_MS`), so a device in use sits
 * near full; one that has not been opened in weeks is the one that empties.
 */
export function sessionOf(until, asOf) {
  const at = Date.parse(until ?? '')
  if (Number.isNaN(at)) return null
  const left = Math.max(0, at - asOf)
  const share = Math.min(100, (left / SESSION_MS) * 100)
  const said =
    left === 0
      ? 'now'
      : left >= 2 * DAY
        ? `${Math.floor(left / DAY)}d`
        : left >= 3_600_000
          ? `${Math.floor(left / 3_600_000)}h`
          : `${Math.max(1, Math.floor(left / 60_000))}m`
  const pressure = left < DAY ? 'tight' : left < 7 * DAY ? 'warm' : 'fine'
  return { share, said, pressure, ends: dateSaid(until, asOf), endsOn: daySaid(until, asOf) }
}

/* ── every device, as the list draws them ──────────────────────────────────── */

/**
 * The device list, in the order it is drawn: this device first, then the
 * newest paired. A label nobody filled in is said as such rather than drawn
 * as an empty name.
 */
export function listOf(rows, asOf) {
  if (!Array.isArray(rows)) return null
  const at = (one) => {
    const was = Date.parse(one.pairedAt ?? '')
    return Number.isNaN(was) ? null : was
  }
  return rows
    .map((one) => {
      const kind = kindOf(one.label)
      const paired = at(one)
      const named = String(one.label ?? '').trim()
      return {
        key: one.device,
        name: named === '' ? 'Unnamed device' : named,
        named: named !== '',
        kind,
        icon: KINDS[kind].icon,
        kindWord: KINDS[kind].word,
        you: one.you === true,
        fresh: one.you !== true && paired !== null && asOf - paired < NEW_FOR,
        at: paired,
        ago: paired === null ? null : agoSaid(paired, asOf),
        when: paired === null ? null : dateSaid(one.pairedAt, asOf),
      }
    })
    .sort((a, b) => {
      if (a.you !== b.you) return a.you ? -1 : 1
      return (b.at ?? Number.NEGATIVE_INFINITY) - (a.at ?? Number.NEGATIVE_INFINITY)
    })
}

/** What the list's lead line says: how many, and how recently one was let in. */
export function listSaid(list) {
  if (list === null || list.length === 0) return ''
  const others = list.filter((one) => !one.you)
  const newest = others.find((one) => one.at !== null)
  const n = list.length === 1 ? 'Only this device' : `${list.length} devices`
  if (newest === undefined) return `${n} can reach this machine`
  return `${n} can reach this machine · the newest paired ${newest.ago === 'now' ? 'just now' : `${newest.ago} ago`}`
}

/* ── this device ───────────────────────────────────────────────────────────── */

/**
 * This device, for the lead: its name and kind out of its own session, when
 * it was paired out of the list's row for it, and the session as a gauge.
 * Null with no session.
 */
export function thisOf(session, rows, asOf) {
  if (session === null || session === undefined) return null
  const kind = kindOf(session.label)
  const row = Array.isArray(rows) ? rows.find((one) => one.you === true) : undefined
  const named = String(session.label ?? '').trim()
  return {
    name: named === '' ? 'Unnamed device' : named,
    kind,
    icon: KINDS[kind].icon,
    kindWord: KINDS[kind].word,
    ago: row === undefined ? null : agoSaid(row.pairedAt, asOf),
    when: row === undefined ? null : dateSaid(row.pairedAt, asOf),
    session: sessionOf(session.until, asOf),
  }
}

/**
 * How the stream to the machine stands, as the lead's pill says it: a glyph,
 * a word and a tone, never the tone alone. The glyphs are the header's own
 * (`FRESH_MARKS`); the words are about this device rather than the page.
 */
export function liveOf(standing) {
  switch (standing) {
    case 'live':
      return { glyph: '●', word: 'connected', tone: 't-done' }
    case 'stale':
      return { glyph: '●', word: 'connected, quiet', tone: 't-done' }
    case 'connecting':
      return { glyph: '◴', word: 'connecting', tone: 't-working' }
    case 'reconnecting':
      return { glyph: '◴', word: 'reconnecting', tone: 't-working' }
    case 'closed':
      return { glyph: '⏸', word: 'stream closed', tone: null }
    default:
      return { glyph: '○', word: 'cannot reach Tade', tone: 't-failed' }
  }
}

/**
 * What the lead draws instead of this device, or null when it can draw it:
 * asking before the first answer, and the answer not coming.
 */
export function leadState(session, asked) {
  if (session !== null && session !== undefined) return null
  if (asked === 'failed') {
    return { kind: 'error', heading: TROUBLES.offline.title, line: TROUBLES.offline.fix }
  }
  return { kind: 'loading', heading: 'Reading this device', line: null }
}

/* ── what this device said ─────────────────────────────────────────────────── */

/**
 * What this device itself sent to Tade and the notes it left, newest first —
 * the record of it a device is already granted, and nothing else.
 *
 * **Two grants and two nulls.** The conversation rides on `talk` and the notes
 * on `notes`; with neither, `granted` is false and the page says *not granted*
 * rather than *nothing* — a device that may not read the conversation has not
 * said nothing in it. The verbs a device asked for are journalled under its id
 * at the machine and are not on the wire, which the section's `?` says.
 */
export function recentOf({ chat, notes, device, mayTalk, mayNotes }, asOf) {
  const granted = mayTalk === true || mayNotes === true
  if (!granted || device === null || device === undefined) {
    return { granted, items: [], more: 0, said: '' }
  }
  const by = `device ${device}`
  const lines = (mayTalk ? (chat ?? []) : [])
    .filter((one) => one.kind === 'asked' && one.from === by && one.text !== null)
    .map((one) => ({ key: `c:${one.id}`, kind: 'asked', icon: 'talk', said: one.text, at: one.at }))
  const kept = (mayNotes ? (notes ?? []) : [])
    .filter((one) => one.by === by && (one.summary ?? one.text) !== null)
    .map((one) => ({
      key: `n:${one.id}`,
      kind: 'note',
      icon: 'notes',
      said: one.summary ?? one.text,
      at: one.at,
    }))
  const all = [...lines, ...kept]
    .map((one) => ({ ...one, ago: agoSaid(one.at, asOf), when: dateSaid(one.at, asOf) }))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  const items = all.slice(0, RECENT)
  const more = all.length - items.length
  const of = { asked: 'message', note: 'note' }
  const counted = (kind) => all.filter((one) => one.kind === kind).length
  const said = [
    ['asked', counted('asked')],
    ['note', counted('note')],
  ]
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${of[kind]}${n === 1 ? '' : 's'}`)
    .join(' · ')
  return { granted, items, more, said }
}
