import { PROTOCOL_VERSION } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { framesIn } from '../src/frames.ts'
import {
  answered,
  DIAL_MS,
  dialDue,
  dialling,
  dialStuck,
  ended,
  heard,
  heldFor,
  lost,
  PRESENCE_EVERY_MS,
  presenceDue,
  QUIET_MS,
  quiet,
  readDelta,
  readSnapshot,
  SIGNED_OUT,
  type StreamFrame,
} from '../src/held.ts'
import type { Held } from '../src/port.ts'

// The rules a held value moves by, as tables: no socket, no clock, no link.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'
const NOW = 1_000_000

function snapshot(rev: number, projects: string[], epoch = EPOCH): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    fresh: {
      at: '',
      epoch,
      rev,
      openedAt: '',
      machineUpSince: null,
      spendSince: null,
      warnings: [],
    },
    you: {},
    pages: {},
    projects: projects.map((name) => ({ name, title: '', open: true, can: [], cannot: [] })),
    tasks: [],
    queue: [],
    findings: [],
    notes: [],
    plans: [],
    chat: [],
    intake: [],
    sources: [],
    runs: [],
    workflows: [],
    // A field this Tade has never heard of, which a newer remote may send.
    later: { added: true },
  })
}

function delta(rev: number, add: string): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    rev,
    at: '',
    fresh: null,
    set: { projects: { [add]: { name: add, title: '', open: true, can: [], cannot: [] } } },
    del: {},
  })
}

const frame = (event: string, data: string, id: string | null = null): StreamFrame => ({
  event,
  id,
  data,
})

/** A link that is up and holds a projection at revision 3. */
function upAt3(): Held {
  const live = answered(heldFor('vps'), 200, 'text/event-stream; charset=utf-8', NOW).held
  return heard(live, frame('snapshot', snapshot(3, ['a']), `${EPOCH}:3`), NOW).held
}

describe('when a dial is due', () => {
  it('dials one never dialled, waits a growing while after a failure, and never redials an ended one', () => {
    const fresh = heldFor('vps')
    expect(dialDue(fresh, NOW)).toBe(true)
    const once = lost(dialling(fresh, NOW), 'failed', 'no', NOW)
    expect(once.link).toMatchObject({ kind: 'down', tries: 1 })
    expect(dialDue(once, NOW + 999)).toBe(false)
    expect(dialDue(once, NOW + 1_000)).toBe(true)
    const thrice = lost(lost(once, 'failed', 'no', NOW), 'failed', 'no', NOW)
    expect(thrice.link).toMatchObject({ tries: 3 })
    expect(dialDue(thrice, NOW + 3_999)).toBe(false)
    expect(dialDue(thrice, NOW + 4_000)).toBe(true)
    // However many: never oftener than fifteen seconds, and never slower.
    let many = thrice
    for (let i = 0; i < 20; i++) many = lost(many, 'timed out', 'no', NOW)
    expect(dialDue(many, NOW + 14_999)).toBe(false)
    expect(dialDue(many, NOW + 15_000)).toBe(true)
    expect(dialDue(dialling(fresh, NOW), NOW + 60_000)).toBe(false)
    expect(dialDue(upAt3(), NOW + 60_000)).toBe(false)
    const over = ended(upAt3(), 'gone', NOW)
    expect(dialDue(over, NOW + 3_600_000)).toBe(false)
    // And nothing that happens to a stream afterwards un-ends it.
    expect(lost(over, 'failed', 'no', NOW).link.kind).toBe('ended')
  })

  it('gives up on a dial past its deadline, and on a live stream gone quiet', () => {
    const dial = dialling(heldFor('vps'), NOW)
    expect(dialStuck(dial, NOW + DIAL_MS)).toBe(false)
    expect(dialStuck(dial, NOW + DIAL_MS + 1)).toBe(true)
    expect(quiet(upAt3(), NOW + QUIET_MS)).toBe(false)
    expect(quiet(upAt3(), NOW + QUIET_MS + 1)).toBe(true)
  })
})

describe('what a dial’s answer does', () => {
  it.each([
    [200, 'text/event-stream', 'live', 'go on'],
    [204, '', 'ended', 'drop'],
    [401, 'application/json', 'ended', 'drop'],
    [404, 'application/json', 'down', 'drop'],
    [503, 'application/json', 'down', 'drop'],
    [500, 'application/json', 'down', 'drop'],
    [200, 'text/html', 'down', 'drop'],
  ])('%i %s is %s, then %s', (status, type, kind, then) => {
    const one = answered(heldFor('vps'), status, type, NOW)
    expect(one.held.link.kind).toBe(kind)
    expect(one.next).toBe(then)
  })

  it('says a session nobody there knows as something to do', () => {
    const one = answered(heldFor('vps'), 204, '', NOW)
    expect(one.held.link).toMatchObject({ kind: 'ended', said: SIGNED_OUT })
    expect(SIGNED_OUT).toContain('tade remote add')
  })
})

describe('what a frame does', () => {
  it('takes a snapshot with its cursor, keeping fields it has never heard of', () => {
    const held = upAt3()
    expect(held.cursor).toEqual({ epoch: EPOCH, rev: 3 })
    expect(held.projection?.projects.map((p) => p.name)).toEqual(['a'])
    expect((held.projection as unknown as { later: unknown }).later).toEqual({ added: true })
  })

  it('applies the next revision, ignores one behind, applies a repeat harmlessly', () => {
    const next = heard(upAt3(), frame('delta', delta(4, 'b'), `${EPOCH}:4`), NOW + 1)
    expect(next.next).toBe('go on')
    expect(next.held.cursor?.rev).toBe(4)
    expect(next.held.projection?.projects.map((p) => p.name)).toEqual(['a', 'b'])
    expect(next.held.heardAt).toBe(NOW + 1)
    const behind = heard(next.held, frame('delta', delta(2, 'z'), `${EPOCH}:2`), NOW + 2)
    expect(behind.next).toBe('go on')
    expect(behind.held.projection?.projects.map((p) => p.name)).toEqual(['a', 'b'])
    const again = heard(next.held, frame('delta', delta(4, 'b'), `${EPOCH}:4`), NOW + 3)
    expect(again.held.projection?.projects.map((p) => p.name)).toEqual(['a', 'b'])
    expect(again.held.cursor?.rev).toBe(4)
  })

  it.each([
    ['a revision skipped', delta(5, 'c'), `${EPOCH}:5`],
    ['another server’s epoch', delta(4, 'c'), '00000000-0000-4000-8000-000000000000:4'],
    ['an id that is no cursor', delta(4, 'c'), 'nonsense'],
    ['an id that disagrees with its revision', delta(4, 'c'), `${EPOCH}:9`],
  ])('starts over from a snapshot on %s, keeping what it holds', (_why, data, id) => {
    const one = heard(upAt3(), frame('delta', data, id), NOW)
    expect(one.next).toBe('redial')
    expect(one.held.cursor).toBeNull()
    expect(one.held.projection?.projects.map((p) => p.name)).toEqual(['a'])
  })

  it('starts over on a delta with nothing to apply it to', () => {
    const live = answered(heldFor('vps'), 200, 'text/event-stream', NOW).held
    expect(heard(live, frame('delta', delta(1, 'b'), `${EPOCH}:1`), NOW).next).toBe('redial')
  })

  it('goes down on a notice or one stream too many, and ends on a revocation, in the remote’s words', () => {
    const closing = heard(
      upAt3(),
      frame('notice', JSON.stringify({ kind: 'closing', said: 'Tade is closing' })),
      NOW,
    )
    expect(closing.next).toBe('drop')
    expect(closing.held.link).toMatchObject({
      kind: 'down',
      problem: 'failed',
      said: 'Tade is closing',
    })
    expect(closing.held.projection).not.toBeNull()
    const many = heard(upAt3(), frame('too_many', JSON.stringify({ said: 'four already' })), NOW)
    expect(many.held.link).toMatchObject({ kind: 'down', said: 'four already' })
    const revoked = heard(
      upAt3(),
      frame('revoked', JSON.stringify({ why: 'signed out at the machine' })),
      NOW,
    )
    expect(revoked.next).toBe('drop')
    expect(revoked.held.link).toMatchObject({ kind: 'ended', said: 'signed out at the machine' })
    // A frame whose data is not JSON still says something: ours.
    expect(heard(upAt3(), frame('revoked', 'garbage'), NOW).held.link).toMatchObject({
      said: SIGNED_OUT,
    })
  })

  it('reads everything else as the stream being alive', () => {
    for (const event of ['resync', 'reload', 'something-new']) {
      const one = heard(upAt3(), frame(event, '{}'), NOW + 7)
      expect(one.next, event).toBe('go on')
      expect(one.held.heardAt, event).toBe(NOW + 7)
    }
  })
})

describe('reading a frame for its shape', () => {
  it.each([
    ['not JSON', '{', 'not JSON'],
    ['not an object', '[]', 'not an object'],
    ['another version', JSON.stringify({ v: 99 }), 'v99'],
    ['no cursor', JSON.stringify({ v: PROTOCOL_VERSION, fresh: {} }), 'no cursor'],
    ['a collection missing', snapshot(1, []).replace('"tasks":[],', ''), 'no tasks'],
  ])('refuses a snapshot that is %s', (_what, data, says) => {
    const read = readSnapshot(data)
    expect(typeof read).toBe('string')
    expect(read).toContain(says)
  })

  it.each([
    ['not JSON', '{', 'not JSON'],
    ['not an object', 'null', 'not an object'],
    ['another version', JSON.stringify({ v: 0 }), 'v0'],
    ['no revision', JSON.stringify({ v: PROTOCOL_VERSION, set: {}, del: {} }), 'no revision'],
    [
      'a freshness that is none',
      JSON.stringify({ v: PROTOCOL_VERSION, rev: 1, set: {}, del: {}, fresh: 3 }),
      'freshness',
    ],
  ])('refuses a delta that is %s', (_what, data, says) => {
    const read = readDelta(data)
    expect(typeof read).toBe('string')
    expect(read).toContain(says)
  })

  it('says to update the older machine when the versions differ', () => {
    expect(readSnapshot(JSON.stringify({ v: 2 }))).toContain('update the older of the two')
  })

  it('goes down rather than applying a frame it cannot read', () => {
    const one = heard(upAt3(), frame('snapshot', '{'), NOW)
    expect(one.next).toBe('drop')
    expect(one.held.link.kind).toBe('down')
    expect(heard(upAt3(), frame('delta', '{'), NOW).held.link.kind).toBe('down')
  })
})

describe('when presence is carried', () => {
  it('carries a new keypress at once, then no oftener than its interval, and nothing stale', () => {
    expect(presenceDue(null, null, NOW)).toBe(false)
    expect(presenceDue(NOW - 1_000, null, NOW)).toBe(true)
    const sent = { pressedAt: NOW - 1_000, at: NOW }
    expect(presenceDue(NOW - 1_000, sent, NOW + 60_000)).toBe(false)
    expect(presenceDue(NOW + 5_000, sent, NOW + 6_000)).toBe(false)
    expect(presenceDue(NOW + 5_000, sent, NOW + PRESENCE_EVERY_MS)).toBe(true)
    // Past what the remote would take, or from the future, it is not said at all.
    expect(presenceDue(NOW - 11 * 60_000, null, NOW)).toBe(false)
    expect(presenceDue(NOW + 1, null, NOW)).toBe(false)
  })
})

describe('reading the stream', () => {
  it('finishes whole frames, keeps half of one, and knows a comment from a frame', () => {
    const text = `retry: 2000\n:${'-'.repeat(20)}\n\nevent: snapshot\nid: ${EPOCH}:3\ndata: {"a":1}\n\n: keep-alive\n\nevent: delta\r\nid: ${EPOCH}:4\r\ndata: {"b"\r\ndata: :2}\r\n\r\nevent: delta\ndata: {`
    const read = framesIn(text)
    expect(read.frames).toEqual([
      { event: 'snapshot', id: `${EPOCH}:3`, data: '{"a":1}' },
      { event: 'delta', id: `${EPOCH}:4`, data: '{"b"\n:2}' },
    ])
    expect(read.rest).toBe('event: delta\ndata: {')
    expect(framesIn(`${read.rest}}\n\n`).frames).toEqual([{ event: 'delta', id: null, data: '{}' }])
    expect(framesIn('field-nobody-knows\ndata\n\n').frames).toEqual([
      { event: 'message', id: null, data: '' },
    ])
  })
})
