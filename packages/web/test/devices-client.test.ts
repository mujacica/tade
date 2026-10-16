import { describe, expect, it } from 'vitest'
import {
  agoSaid,
  answered,
  DAY,
  DOES,
  dateSaid,
  daySaid,
  FLOOR,
  KINDS,
  kindOf,
  leadState,
  listOf,
  listSaid,
  listState,
  liveOf,
  matrixOf,
  NEW_FOR,
  READS,
  RECENT,
  reachOf,
  recentOf,
  recentState,
  SESSION_MS,
  sessionOf,
  tellingOf,
  thisOf,
} from '../src/assets/pages/devices-shape.js'
import { CANNOT, DENIED, INSECURE, NOT_OFFERED, OFF, ON, PUSH_SAID } from '../src/assets/push.js'
import { GRANTS as PAGE_GRANTS } from '../src/assets/store.js'
import { TROUBLES } from '../src/assets/trouble.js'
import { type Device, listing } from '../src/devices.ts'
import type { NoteIn } from '../src/input.ts'
import type { Keeping } from '../src/installable.ts'
import { GRANTS } from '../src/reach.ts'
import { SESSION_MS as SESSION_LENGTH } from '../src/sessions.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { SCOPES } from '../src/surface.ts'
import { EVERY, input, NOW, note, reach, talk } from './fixtures.ts'

// What the devices page draws, against **what the machine actually sends**:
// the list and this device's own session come out of `listing`, the function
// `/api/devices` answers with, and what this device said comes out of
// `snapshotOf` — so a field either renames is a red test here rather than a
// blank card on a phone. And the page's one rule about other devices: it says
// nothing about one that the wire did not carry, which is a name and a date.

const ME = 'a1b2c3d4e5f60718'
const OTHER = 'b2c3d4e5f6071829'

/** A device as the file folds one, paired `ago` ms before `NOW`. */
function device(over: Partial<Device> = {}): Device {
  return {
    id: ME,
    label: 'iPhone',
    digest: 'f'.repeat(64),
    host: 'localhost:7654',
    csrf: 'csrf-token',
    until: NOW + SESSION_LENGTH,
    pairedAt: NOW - 3 * DAY,
    scopes: ['read'],
    projects: null,
    granted: [],
    from: '192.168.1.20',
    revoked: null,
    owner: false,
    passkey: null,
    ...over,
  }
}

const KEEPING: Keeping = {
  install: false,
  keepsView: false,
  notifying: { offered: false, key: null },
} as unknown as Keeping

/** A device whose acting asks for no passkey: this machine, a tailnet. */
const NOT_ASKED = { asks: false, made: false, proven: false, until: null, makeBy: null, hours: 12 }

/** What `/api/devices` answers this device with, for these devices. */
function listed(me: Device, others: Device[] = []) {
  return listing(me, [me, ...others], KEEPING, NOT_ASKED) as unknown as {
    you: { device: string; label: string; reads: string[]; scopes: string[]; until: string }
    devices: { device: string; label: string; pairedAt: string; you: boolean }[]
  }
}

describe('what kind of device a name is', () => {
  it('reads every word the pairing screen suggests as the kind it names', () => {
    // `deviceWord` in `pair.js`: the label a phone is paired under unless
    // somebody changed it.
    expect(kindOf('iPhone')).toBe('phone')
    expect(kindOf('Android phone')).toBe('phone')
    expect(kindOf('iPad')).toBe('tablet')
    expect(kindOf('Android tablet')).toBe('tablet')
    for (const word of ['Mac', 'Windows PC', 'Chromebook', 'Linux']) {
      expect(kindOf(word), word).toBe('computer')
    }
  })

  it('calls a name it does not recognise a device, never a phone', () => {
    expect(kindOf('')).toBe('device')
    expect(kindOf(null)).toBe('device')
    expect(kindOf('Kitchen display')).toBe('device')
  })

  it('draws every kind with an icon the sprite has and a word', () => {
    for (const one of Object.values(KINDS)) {
      expect(['devices', 'laptop']).toContain(one.icon)
      expect(one.word.length).toBeGreaterThan(0)
    }
  })
})

describe('how this device reaches the machine', () => {
  it('is this machine on any loopback spelling', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'tade.localhost']) {
      const at = reachOf(host, 'http:')
      expect(at.kind, host).toBe('machine')
      expect(at.word).toBe('this machine')
      expect(at.plain).toBe(false)
    }
  })

  it('says plain HTTP across a network, and only there', () => {
    for (const host of ['192.168.1.20', '10.0.0.4', '172.20.1.1', 'studio.local']) {
      const at = reachOf(host, 'http:')
      expect(at.kind, host).toBe('network')
      expect(at.word).toBe('your network')
      expect(at.plain).toBe(true)
      expect(at.under).toContain('plain HTTP')
    }
    expect(reachOf('192.168.1.20', 'https:').plain).toBe(false)
  })

  it('names Tailscale by its addresses and its names', () => {
    expect(reachOf('100.101.2.3', 'http:').word).toBe('Tailscale')
    expect(reachOf('studio.tail1234.ts.net', 'https:')).toMatchObject({
      kind: 'tailscale',
      under: 'https',
      plain: false,
    })
  })

  it('says a name it cannot place as itself, and nothing for no address', () => {
    expect(reachOf('tade.example.com', 'https:')).toMatchObject({
      kind: 'named',
      word: 'tade.example.com',
    })
    expect(reachOf('', 'http:')).toMatchObject({ kind: 'unknown', word: null, plain: false })
  })

  it('never says a network is anything comfortable', () => {
    for (const host of ['192.168.1.20', 'studio.local', 'tade.example.com', '100.101.2.3']) {
      for (const protocol of ['http:', 'https:']) {
        const said = `${reachOf(host, protocol).word} ${reachOf(host, protocol).under}`
        for (const word of ['secure', 'encrypted', 'private', 'safe']) {
          expect(said.toLowerCase()).not.toContain(word)
        }
      }
    }
  })
})

describe('what this device was granted, as a matrix', () => {
  it('has a cell for every reading grant the machine knows, in its order', () => {
    expect(READS.map((one) => one.key)).toEqual([...GRANTS])
    expect(READS.map((one) => one.key)).toEqual(PAGE_GRANTS)
  })

  it('has a cell for every scope beyond reading, and reading is the floor', () => {
    expect(['read', ...DOES.map((one) => one.key)].sort()).toEqual([...SCOPES].sort())
  })

  it('draws a device paired with nothing granted as the floor and every cell off', () => {
    const { you } = listed(device())
    const matrix = matrixOf(you)
    expect(matrix).not.toBeNull()
    if (matrix === null) return
    expect(matrix.read[0]).toMatchObject({ key: FLOOR.key, on: true, floor: true })
    expect(matrix.read.slice(1).every((one) => !one.on)).toBe(true)
    expect(matrix.does.every((one) => !one.on)).toBe(true)
    expect(matrix.readSaid).toBe(`1 of ${GRANTS.length + 1}`)
    expect(matrix.doSaid).toBe('read only')
  })

  it('lights exactly what was granted at the machine, and draws the rest off', () => {
    const { you } = listed(
      device({ granted: ['titles', 'spend', 'talk'], scopes: ['read', 'answer', 'steer', 'ask'] }),
    )
    const matrix = matrixOf(you)
    if (matrix === null) throw new Error('no matrix')
    const lit = (cells: { key: string; on: boolean }[]) =>
      cells.filter((one) => one.on).map((one) => one.key)
    expect(lit(matrix.read)).toEqual([FLOOR.key, 'titles', 'spend', 'talk'])
    expect(lit(matrix.does)).toEqual(['answer', 'steer', 'ask'])
    expect(matrix.read).toHaveLength(GRANTS.length + 1)
    expect(matrix.does).toHaveLength(SCOPES.length - 1)
    expect(matrix.doSaid).toBe(`3 of ${SCOPES.length - 1}`)
  })

  it('draws no cell for a word nothing grants, and nothing at all with no session', () => {
    const matrix = matrixOf({ reads: ['titles', 'everything'], scopes: ['read', 'root'] })
    if (matrix === null) throw new Error('no matrix')
    expect(matrix.read.map((one) => one.key)).not.toContain('everything')
    expect(matrix.does.map((one) => one.key)).not.toContain('root')
    expect(matrixOf(null)).toBeNull()
  })
})

describe('every device, as the list draws them', () => {
  it('puts this device first and the rest newest paired first', () => {
    const { devices } = listed(device(), [
      device({ id: OTHER, label: 'Mac', pairedAt: NOW - 10 * DAY }),
      device({ id: 'c3d4e5f607182930', label: 'iPad', pairedAt: NOW - 2 * 3_600_000 }),
    ])
    const list = listOf(devices, NOW)
    expect(list?.map((one) => one.name)).toEqual(['iPhone', 'iPad', 'Mac'])
    expect(list?.[0]?.you).toBe(true)
    expect(list?.map((one) => one.kind)).toEqual(['phone', 'tablet', 'computer'])
  })

  it('marks a device let in within a day as new, and never this one', () => {
    const { devices } = listed(device({ pairedAt: NOW - 60_000 }), [
      device({ id: OTHER, label: 'Mac', pairedAt: NOW - NEW_FOR + 60_000 }),
      device({ id: 'c3d4e5f607182930', label: 'Linux', pairedAt: NOW - NEW_FOR - 60_000 }),
    ])
    const fresh = Object.fromEntries(
      (listOf(devices, NOW) ?? []).map((one) => [one.name, one.fresh]),
    )
    expect(fresh).toEqual({ iPhone: false, Mac: true, Linux: false })
  })

  it('says nothing about another device beyond its name, its kind and when', () => {
    // The wire carries a label and a moment for another device — no address,
    // no grant, no activity — and the row is made of exactly those.
    const { devices } = listed(device(), [device({ id: OTHER, label: 'Mac', from: '10.0.0.9' })])
    const other = devices.find((one) => !one.you)
    expect(Object.keys(other ?? {}).sort()).toEqual(['device', 'label', 'pairedAt', 'you'])
    const row = listOf(devices, NOW)?.find((one) => !one.you)
    expect(JSON.stringify(row)).not.toContain('10.0.0.9')
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'ago',
        'at',
        'fresh',
        'icon',
        'key',
        'kind',
        'kindWord',
        'name',
        'named',
        'when',
        'you',
      ].sort(),
    )
  })

  it('says a label nobody filled in as such, and nothing before the list arrives', () => {
    const list = listOf([{ device: OTHER, label: '  ', pairedAt: 'not a moment', you: false }], NOW)
    expect(list?.[0]).toMatchObject({ name: 'Unnamed device', named: false, ago: null, when: null })
    expect(listOf(null, NOW)).toBeNull()
  })

  it('leads with how many devices can get in and the newest of the others', () => {
    const { devices } = listed(device(), [
      device({ id: OTHER, label: 'Mac', pairedAt: NOW - 5 * 3_600_000 }),
    ])
    expect(listSaid(listOf(devices, NOW))).toBe(
      '2 devices can reach this machine · the newest paired 5h ago',
    )
    expect(listSaid(listOf(listed(device()).devices, NOW))).toBe(
      'Only this device can reach this machine',
    )
    expect(listSaid(null)).toBe('')
  })
})

describe('asking for the list again', () => {
  it('worked only where the list was replaced, which an answer always does', () => {
    const held = [{ device: ME, label: 'iPhone', pairedAt: '', you: true }]
    expect(answered(held, [...held])).toBe('done')
    expect(answered(null, held)).toBe('done')
    expect(answered(held, held)).toBe('failed')
    expect(answered(null, null)).toBe('failed')
  })

  it('draws a skeleton while the first answer is coming, and the machine not answering after', () => {
    expect(listState(null, 'asking')).toEqual({ coming: true, box: null, stale: false })
    const failed = listState(null, 'failed')
    expect(failed.coming).toBe(false)
    expect(failed.box).toMatchObject({
      kind: 'error',
      heading: TROUBLES.offline?.title,
      retry: true,
    })
  })

  it('keeps a list it already had, said as the one from before, rather than an error', () => {
    const list = listOf(listed(device()).devices, NOW)
    expect(listState(list, 'failed')).toEqual({ coming: false, box: null, stale: true })
    expect(listState(list, 'done')).toEqual({ coming: false, box: null, stale: false })
    expect(listState(list, 'asking')).toEqual({ coming: false, box: null, stale: false })
  })

  it('says no device is paired for an empty list, with nothing to press', () => {
    expect(listState([], 'done').box).toMatchObject({ kind: 'empty', retry: false })
  })
})

describe('notifications on this device', () => {
  it('draws nothing while the machine is not offering them or the phone has not answered', () => {
    expect(tellingOf(NOT_OFFERED).drawn).toBe(false)
    expect(tellingOf(null).drawn).toBe(false)
    expect(tellingOf(null).said).toBe('asking…')
  })

  it('says every standing in its own word and the push table’s own sentence', () => {
    const words = new Set<string>()
    for (const standing of [ON, OFF, DENIED, INSECURE, CANNOT]) {
      const one = tellingOf(standing)
      expect(one.drawn, standing).toBe(true)
      expect(one.said).toBe(PUSH_SAID[standing])
      words.add(one.word)
    }
    expect(words.size).toBe(5)
  })

  it('offers the press only where a press could change it', () => {
    expect(tellingOf(ON)).toMatchObject({ on: true, press: 'Stop telling this device' })
    expect(tellingOf(OFF)).toMatchObject({ on: false, press: 'Tell this device' })
    for (const standing of [DENIED, INSECURE, CANNOT]) {
      expect(tellingOf(standing).press, standing).toBeNull()
    }
  })
})

describe('this device, for the lead', () => {
  it('is its own session’s name and kind, and the list’s moment it was paired', () => {
    const { you, devices } = listed(device({ label: 'Windows PC' }))
    const one = thisOf(you, devices, NOW)
    expect(one).toMatchObject({ name: 'Windows PC', kind: 'computer', icon: 'laptop', ago: '3d' })
    expect(one?.when).toBe(dateSaid(new Date(NOW - 3 * DAY).toISOString(), NOW))
    expect(thisOf(null, devices, NOW)).toBeNull()
    expect(thisOf({ ...you, label: '' }, devices, NOW)?.name).toBe('Unnamed device')
  })

  it('draws a full session as full, and is worried only near its end', () => {
    expect(SESSION_MS).toBe(SESSION_LENGTH)
    const at = (left: number) => sessionOf(new Date(NOW + left).toISOString(), NOW)
    expect(at(SESSION_MS)).toMatchObject({ share: 100, said: '30d', pressure: 'fine' })
    expect(at(SESSION_MS)?.endsOn).toBe(daySaid(NOW + SESSION_MS, NOW))
    expect(at(3 * DAY)).toMatchObject({ said: '3d', pressure: 'warm' })
    expect(at(5 * 3_600_000)).toMatchObject({ said: '5h', pressure: 'tight' })
    expect(at(-60_000)).toMatchObject({ share: 0, said: 'now', pressure: 'tight' })
    expect(sessionOf('never', NOW)).toBeNull()
  })

  it('says how the stream stands with a glyph and a word, never a tone alone', () => {
    for (const standing of [
      'live',
      'stale',
      'connecting',
      'reconnecting',
      'closed',
      'unreachable',
    ]) {
      const one = liveOf(standing)
      expect(one.glyph.length, standing).toBeGreaterThan(0)
      expect(one.word.length, standing).toBeGreaterThan(0)
    }
    expect(liveOf('live').word).not.toBe(liveOf('unreachable').word)
  })

  it('is coming before the first answer and wrong only once one did not come', () => {
    expect(leadState(null, 'asking')).toMatchObject({ kind: 'loading' })
    expect(leadState(null, 'failed')).toMatchObject({
      kind: 'error',
      heading: TROUBLES.offline?.title,
      line: TROUBLES.offline?.fix,
    })
    expect(leadState(listed(device()).you, 'failed')).toBeNull()
  })
})

describe('what this device said', () => {
  /** The rows a device granted these is handed, for these notes and the fixture's conversation. */
  function rows(granted: typeof EVERY, notes: NoteIn[] = []) {
    const snapshot = snapshotOf(input({ reach: reach(granted), talk: talk(), notes }), NOW)
    return { chat: snapshot.chat, notes: [...snapshot.notes].reverse() }
  }
  const mine = `device ${ME}`

  it('is its own messages and notes, newest first, as they were said', () => {
    const { chat, notes } = rows(EVERY, [
      note({ by: mine, at: '2026-10-08T14:10:00.000Z', text: 'ring me if the deploy goes red' }),
      note({ by: 'voice', at: '2026-10-08T14:20:00.000Z' }),
    ])
    const recent = recentOf({ chat, notes, device: ME, mayTalk: true, mayNotes: true }, NOW)
    expect(recent.granted).toBe(true)
    expect(recent.items.map((one) => one.kind)).toEqual(['note', 'asked'])
    // The words reach the page exactly as the row carried them.
    const asked = chat.find((one) => one.from === mine)
    expect(recent.items[1]?.said).toEqual(asked?.text)
    expect(recent.items[0]?.said).toEqual(notes.find((one) => one.by === mine)?.summary)
    expect(recent.said).toBe('1 message · 1 note')
  })

  it('leaves out what anybody else said, the person at the machine included', () => {
    const { chat, notes } = rows(EVERY)
    const recent = recentOf({ chat, notes, device: OTHER, mayTalk: true, mayNotes: true }, NOW)
    expect(recent.items).toEqual([])
    expect(recent.said).toBe('')
  })

  it('says not granted rather than nothing where neither was granted', () => {
    const { chat, notes } = rows([])
    const recent = recentOf({ chat, notes, device: ME, mayTalk: false, mayNotes: false }, NOW)
    expect(recent).toMatchObject({ granted: false, items: [], said: '' })
  })

  it('says not granted and nothing yet as two different sentences, and nothing over lines', () => {
    const { chat, notes } = rows(EVERY)
    const none = recentState(
      recentOf({ chat, notes, device: OTHER, mayTalk: true, mayNotes: true }, NOW),
    )
    const withheld = recentState(
      recentOf({ chat, notes, device: ME, mayTalk: false, mayNotes: false }, NOW),
    )
    expect(none?.heading).toBe('Nothing sent from here yet')
    expect(withheld?.heading).toBe('Not granted to this device')
    const some = recentOf({ chat, notes, device: ME, mayTalk: true, mayNotes: true }, NOW)
    expect(some.items.length).toBeGreaterThan(0)
    expect(recentState(some)).toBeNull()
    expect(recentState(null)).toBeNull()
  })

  it('shows the newest few and counts the rest', () => {
    const many = Array.from({ length: RECENT + 3 }, (_, at) =>
      note({ by: mine, at: new Date(NOW - (at + 1) * 60_000).toISOString(), summary: undefined }),
    )
    const { chat, notes } = rows(EVERY, many)
    const recent = recentOf({ chat, notes, device: ME, mayTalk: false, mayNotes: true }, NOW)
    expect(recent.items).toHaveLength(RECENT)
    expect(recent.more).toBe(3)
    expect(recent.items[0]?.ago).toBe('1m')
  })
})

describe('ages and moments', () => {
  it('says an age in its one largest unit, and nothing for no moment', () => {
    expect(agoSaid(NOW - 30_000, NOW)).toBe('now')
    expect(agoSaid(NOW - 12 * 60_000, NOW)).toBe('12m')
    expect(agoSaid(NOW - 4 * 3_600_000, NOW)).toBe('4h')
    expect(agoSaid(NOW - 3 * DAY, NOW)).toBe('3d')
    expect(agoSaid(null, NOW)).toBeNull()
  })

  it('says a date with its year only where it is not this one', () => {
    expect(dateSaid('2026-10-08T09:05:00', NOW)).toBe('Oct 8, 09:05')
    expect(dateSaid('2025-01-02T10:00:00', NOW)).toBe('Jan 2 2025, 10:00')
    expect(daySaid('2026-10-08T09:05:00', NOW)).toBe('Oct 8')
    expect(dateSaid(null, NOW)).toBeNull()
  })
})
