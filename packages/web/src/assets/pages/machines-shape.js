// The Machines page's words and figures, out of `POST /api/machines`
// (`src/machines.ts`): pure, so every line of it is a test
// (`test/machines-page-client.test.ts`) rather than something to make happen.
//
// The grid is the window's (`machineGrid`), and so are its marks; what is the
// page's own is how a row reads on a phone — a line per machine under the
// item's name, the mark, its word and the days a sign-in has left — because a
// column per machine does not fit 360px and nothing here is cut to fit.

/** Each kind of item, headed as Settings › Machines heads it. */
export const KIND_TITLE = {
  'sign-in': 'Sign-ins',
  secret: 'Keys',
  env: 'Environment keys',
  mcp: 'MCP servers',
  git: 'Git',
  origin: 'Origin, with this machine’s credentials',
  app: 'Per-machine apps',
  public: 'Public name',
}

/** A mark in words: a colour and a glyph are never the only statement of one. */
export const MARK_SAID = {
  '✓': 'set',
  '✗': 'missing',
  '≠': 'a different key',
  '—': 'not used there',
  '?': 'cannot tell',
}

/** The tone a mark is drawn in: set is green, missing red, a different key amber, the rest quiet. */
export function markTone(mark) {
  if (mark === '✓') return 'done'
  if (mark === '✗') return 'failed'
  if (mark === '≠') return 'working'
  return 'quiet'
}

/** One cell, as its line says it: `✓ set · 12 days left`. */
export function cellSaid(cell) {
  const word = MARK_SAID[cell.mark] ?? 'cannot tell'
  if (cell.days === null || cell.days === undefined) return word
  return `${word} · ${cell.days} day${cell.days === 1 ? '' : 's'} left`
}

/** Under a machine's name: why it has nothing to say, when it last said, or that it is this one. */
export function columnSaid(column, clock) {
  if (column.said) return column.said
  if (column.here) return 'this machine, now'
  if (column.asOf) return `as of ${clock(column.asOf)}`
  return 'it has not said what it has'
}

/** The rows, a group per kind in the order the grid gives them. */
export function groupsOf(answer) {
  const groups = []
  for (const row of answer?.rows ?? []) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.kind === row.kind) last.rows.push(row)
    else groups.push({ kind: row.kind, head: KIND_TITLE[row.kind] ?? row.kind, rows: [row] })
  }
  return groups
}

/** Which column is this machine's, or -1. */
export function hereAt(answer) {
  return (answer?.columns ?? []).findIndex((one) => one.here)
}

/**
 * The four figures that lead the page: how many machines, how many items,
 * what is missing here, and what differs between them. Null before the first
 * look, which the tiles draw as `—`, never as nought.
 */
export function leadOf(answer) {
  const columns = answer?.columns ?? null
  if (columns === null) {
    return [
      { key: 'machines', label: 'Machines', value: null, under: 'looking' },
      { key: 'items', label: 'Items', value: null, under: '' },
      { key: 'missing', label: 'Missing here', value: null, under: '' },
      { key: 'differ', label: 'Differ', value: null, under: '' },
    ]
  }
  const here = hereAt(answer)
  let missing = 0
  let differ = 0
  for (const row of answer.rows) {
    if (here >= 0 && row.cells[here]?.mark === '✗') missing++
    if (row.cells.some((cell) => cell.mark === '≠')) differ++
  }
  const others = columns.length - 1
  return [
    {
      key: 'machines',
      label: 'Machines',
      value: String(columns.length),
      under:
        others === 0 ? 'this one only' : `this one and ${others} other${others === 1 ? '' : 's'}`,
    },
    {
      key: 'items',
      label: 'Items',
      value: String(answer.rows.length),
      under: 'by name, never value',
    },
    {
      key: 'missing',
      label: 'Missing here',
      value: String(missing),
      under: missing === 0 ? 'nothing' : 'set elsewhere, not here',
      tone: missing === 0 ? null : 'failed',
    },
    {
      key: 'differ',
      label: 'Differ',
      value: String(differ),
      under: differ === 0 ? 'every key the same' : 'a different key somewhere',
      tone: differ === 0 ? null : 'working',
    },
  ]
}

/** One press: its id, its word, and what it says between its two presses. */
export function pressesOf(answer) {
  if (answer === null) return []
  const presses = [{ id: 'look', word: answer.looking ? 'Looking…' : 'Look again' }]
  if (answer.plan === null) {
    presses.push({
      id: 'plan',
      word: answer.busy ? 'Working it out…' : `Move keys into ${answer.file}…`,
    })
    return presses
  }
  if (answer.plan.moved.length > 0) {
    presses.push({
      id: 'move',
      word: answer.busy ? 'Moving…' : 'Move them',
      again: 'Press again to move them',
    })
  }
  presses.push({ id: 'leave', word: 'Leave them' })
  return presses
}

/** Whether something is under way, so the page asks again soon rather than in a while. */
export function underWay(answer) {
  return answer === null || answer.columns === null || answer.looking || answer.busy
}

/** A diff line's tone: what goes red, what comes green, the rest a label. */
export function diffTone(line) {
  if (line.includes(' - ')) return 'failed'
  if (line.includes(' + ')) return 'done'
  return 'quiet'
}

/** What one key that cannot be moved says: `left: OPENAI_API_KEY at ~/.zshrc:3 — set by a command`. */
export function leftSaid(one) {
  return `left: ${one.name} at ${one.where} — ${one.why}`
}

/**
 * Why the page could not be read, in its own words where the refusal is the
 * device not being the person's own: the routes answer only a device with full
 * access, which is ticked at the machine. Null for every other refusal, which
 * `trouble.js` words.
 */
export function refusedSaid(got) {
  const kind = got?.body?.error
  if (kind !== 'out_of_scope' && kind !== 'no_such') return null
  // `trouble.js`'s shape, a heading and the one thing to do.
  const title = 'Only your own device'
  return {
    title,
    fix: 'Your machines are shown to a device with full access: tick it for this one at the machine',
  }
}
