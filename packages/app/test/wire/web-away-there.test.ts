import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AWAY_ITSELF,
  type AwayAnswer,
  type Device,
  readDevices,
  type Surface,
  Tickets,
  type Told,
} from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { awayThereFrom } from '../../src/wire/web-away-there.ts'
import type { PanelFacts } from '../../src/wire/web-panel.ts'
import type { Sessions } from '../../src/wire/web-sessions.ts'

// This machine's away view, answered for another machine's tab
// (`web-away-there.ts`), over a real home: a code written as `tade web pair`
// writes one — the digest on the disk, the secret only in the one answer,
// nothing of it in the journal — a device signed out, every one of them, and
// what is refused, each written down as the device's.

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
  homes.length = 0
})

const NOW = Date.parse('2026-11-28T09:00:00.000Z')

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: ['tade.example.com'],
  publicName: 'tade.example.com',
  passkeyMs: 0,
  acting: true,
  talking: true,
  installing: true,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

/** A device paired on this machine's own loopback door. */
const HERE: Device = {
  id: '00112233445566aa',
  label: 'MacBook',
  digest: 'd',
  host: 'localhost:7654',
  csrf: 'c',
  until: NOW + 86_400_000,
  pairedAt: NOW - 3_600_000,
  clear: false,
  from: '127.0.0.1',
  revoked: null,
  owner: false,
  passkey: null,
}

async function made(over: Partial<PanelFacts> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'tade-away-there-'))
  homes.push(home)
  const told: Told[] = []
  const letGo: string[] = []
  const facts = (): PanelFacts => ({
    surface: SURFACE,
    bound: ['127.0.0.1:7654'],
    listening: true,
    publicAt: '/run/tade/away.sock',
    publicTrouble: null,
    health: [],
    ticket: null,
    asking: null,
    devices: [HERE],
    live: new Set([HERE.id]),
    streams: 1,
    problem: null,
    now: NOW,
    ...over,
  })
  const sessions = (): Sessions => ({
    home,
    now: () => NOW,
    listening: () => [],
    keep: () => {},
    letGo: (device) => letGo.push(device),
    news: () => {},
    reread: async () => {},
  })
  const half = awayThereFrom({
    home,
    facts,
    sessions,
    tickets: new Tickets(),
    log: async (line) => {
      told.push(line)
    },
  })
  return { home, half, told, letGo }
}

describe('this machine’s away view, for another machine’s tab', () => {
  it('answers a look with the panel’s own facts, a device paired here named as the machine itself', async () => {
    const { half, told } = await made()
    const answer = await half({}, 'mac')
    expect(answer).toMatchObject({
      listening: true,
      reachable: ['tade.example.com'],
      public: { name: 'tade.example.com', up: true },
      code: null,
      codes: [],
      streams: 1,
      cannot: null,
    })
    expect(answer.devices).toEqual([
      expect.objectContaining({ id: HERE.id, from: AWAY_ITSELF, live: true }),
    ])
    // A look writes nothing down.
    expect(told).toEqual([])
  })

  it('writes a code as `tade web pair` does: the public link once, the digest on the disk, nothing in the journal', async () => {
    const { home, half, told } = await made()
    const answer = await half({ press: 'code' }, 'mac')
    const code = answer.code as NonNullable<AwayAnswer['code']>
    expect(code.url.startsWith('https://tade.example.com/pair#t=')).toBe(true)
    const secret = code.url.slice(code.url.indexOf('#t=') + 3)
    expect(answer.codes).toEqual([{ device: code.device, secondsLeft: code.secondsLeft }])
    expect(code.secondsLeft).toBe(300)
    // Claimable on the public name and nowhere else, and the secret is in the answer alone.
    const pending = (await readDevices(home)).pending
    expect(pending.map((one) => [one.id, one.host])).toEqual([[code.device, 'tade.example.com']])
    expect(await readFile(join(home, 'web-devices.jsonl'), 'utf8')).not.toContain(secret)
    expect(told).toEqual([
      { type: 'web_did', detail: { device: 'mac', verb: 'away code', state: 'done' } },
    ])
    expect(JSON.stringify(told)).not.toContain(secret)
    // A look after it never hands the link back: the secret is kept nowhere here.
    const look = await half({}, 'mac')
    expect(look.code).toBeNull()
    expect(look.codes.map((one) => one.device)).toEqual([code.device])
  })

  it('takes the code before back when it writes another, as the panel and `tade web pair` do', async () => {
    const { half } = await made()
    const first = (await half({ press: 'code' }, 'mac')).code?.device
    const second = await half({ press: 'code' }, 'mac')
    expect(second.codes.map((one) => one.device)).toEqual([second.code?.device])
    expect(second.codes.map((one) => one.device)).not.toContain(first)
  })

  it('signs out one device, or a code nobody claimed, and refuses one that is not paired there', async () => {
    const { half, told, letGo } = await made()
    const code = (await half({ press: 'code' }, 'mac')).code?.device as string
    const gone = await half({ press: 'revoke', device: code }, 'mac')
    expect(gone.codes).toEqual([])
    await half({ press: 'revoke', device: HERE.id }, 'mac')
    expect(letGo).toEqual([code, HERE.id])
    const nobody = await half({ press: 'revoke', device: 'ffffffffffffffff' }, 'mac')
    expect(nobody.cannot).toBe('no such device is paired there')
    expect(told.map((line) => line.detail)).toEqual([
      { device: 'mac', verb: 'away code', state: 'done' },
      { device: 'mac', verb: 'away revoke', state: 'done' },
      { device: 'mac', verb: 'away revoke', state: 'done' },
      { device: 'mac', verb: 'away revoke', state: 'refused' },
    ])
  })

  it('disconnects everything, codes nobody claimed included', async () => {
    const { home, half } = await made()
    await half({ press: 'code' }, 'mac')
    const all = await half({ press: 'revoke all' }, 'mac')
    expect(all.codes).toEqual([])
    expect((await readDevices(home)).pending).toEqual([])
  })

  it('writes no code where its away view is off, and says so', async () => {
    const { home, half, told } = await made({ listening: false, bound: [] })
    const answer = await half({ press: 'code' }, 'mac')
    expect(answer).toMatchObject({
      code: null,
      cannot: 'the away view is off there',
      reachable: [],
    })
    expect((await readDevices(home)).pending).toEqual([])
    expect(told.map((line) => line.detail)).toEqual([
      { device: 'mac', verb: 'away code', state: 'refused' },
    ])
  })
})
