import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyDigest } from '@tade/core'
import { digestOf, GRANTS, SCOPES, writeDevices } from '@tade/web'
import type { AccountView } from '@tade/workbench/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { signInsOf } from '../../src/wire/web-carry.ts'
import { carried, closeAll, DEVICE, machine, paired, SECRET, waitFor } from './away-harness.ts'

// Another machine's setup carried into this window, end to end: a real
// listener, an owner's session, the window's own `Settings.writeKey`, the
// home's real `config.yaml` and the real journal — the remote's half of `tade
// remote add` (`web-carry.ts`).

afterEach(closeAll)

const TOKEN = 'sk-ant-oat01-THE-HARNESS-KEEPS-THIS'

/** What a harness says of its sign-in: who, a plan — and nothing a carry may send but whether and until when. */
const CLAUDE: AccountView = {
  harness: 'claude-code',
  name: null,
  kind: 'subscription',
  canAdd: true,
  why: null,
  status: {
    signedIn: true,
    who: 'me@example.com',
    plan: 'max',
    method: 'claude.ai',
    problem: null,
    until: Date.UTC(2026, 10, 1),
  },
  limits: null,
  agents: 0,
  forNewAgents: true,
  canSignIn: true,
  provider: 'anthropic',
}

/** An owner device in the file, as `tade web pair --owner` writes one, for the harness's cookie. */
async function owner(home: string, port: number): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'mac',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: [...SCOPES],
      projects: null,
      granted: [...GRANTS],
      from: '',
      owner: true,
    },
  ])
}

const fileOf = (home: string) =>
  parse(readFileSync(join(home, 'config.yaml'), 'utf8')) as {
    agents?: { commit?: string }
    extensions?: { jev?: { key?: string } }
  }

describe('a carry into this window', () => {
  it('writes through the window’s own door, applies it, and writes it down as carried', async () => {
    const one = await machine({ realKeys: true, accounts: async () => [CLAUDE] })
    await owner(one.home, one.port)
    await one.away.open()
    const answer = await carried(one.port, {
      from: 'mac',
      complete: false,
      settings: [
        { path: 'agents.commit', value: 'as-you-go' },
        { path: 'extensions.jev.key', digest: keyDigest('jev-1') },
        { path: 'projects.app.root', value: '/elsewhere' },
      ],
    })
    expect(answer.status).toBe(200)
    expect(answer.body.settings).toEqual([
      { path: 'agents.commit', outcome: 'written' },
      { path: 'extensions.jev.key', outcome: 'waiting' },
      { path: 'projects.app.root', outcome: 'refused', why: expect.stringContaining('folder') },
    ])
    expect(fileOf(one.home).agents?.commit).toBe('as-you-go')
    expect(fileOf(one.home).extensions?.jev?.key).toBeUndefined()
    const changed = await waitFor(one.client, 'config_changed')
    expect(changed.map((line) => line.detail)).toEqual([
      { path: 'agents.commit', was: '', now: 'as-you-go', by: `device ${DEVICE}`, carried: 'mac' },
    ])
    // Whether each harness is signed in, and until when — never who as, never a token.
    expect(answer.body.signIns).toEqual([
      {
        harness: 'claude-code',
        account: null,
        signedIn: true,
        until: Date.UTC(2026, 10, 1),
        problem: null,
      },
    ])
    expect(JSON.stringify(answer.body)).not.toContain('me@example.com')
  })

  it('writes a key sent on the press, and its line says how long it was', async () => {
    const one = await machine({ realKeys: true, accounts: async () => [] })
    await owner(one.home, one.port)
    await one.away.open()
    const answer = await carried(one.port, {
      from: 'mac',
      complete: false,
      settings: [{ path: 'extensions.jev.key', value: 'jev-0123456789' }],
    })
    expect(answer.body.settings).toEqual([{ path: 'extensions.jev.key', outcome: 'written' }])
    expect(fileOf(one.home).extensions?.jev?.key).toBe('jev-0123456789')
    const changed = await waitFor(one.client, 'config_changed')
    expect(changed[0]?.detail).toMatchObject({ now: '14 characters', carried: 'mac' })
    expect(JSON.stringify(changed)).not.toContain('jev-0123456789')
  })

  it('is refused to a phone, however much it was granted', async () => {
    const one = await machine({ realKeys: true })
    await paired(one.home, one.port, [...SCOPES], [...GRANTS])
    await one.away.open()
    const answer = await carried(one.port, {
      from: 'phone',
      complete: false,
      settings: [{ path: 'agents.commit', value: 'never' }],
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(fileOf(one.home).agents?.commit).toBeUndefined()
  })
})

describe('what a remote says of its sign-ins', () => {
  it('is whether and until when, for a harness’s own sign-in, and nothing else it keeps', () => {
    const keyPaid: AccountView = { ...CLAUDE, name: 'work', kind: 'api-key' }
    const none: AccountView = { ...CLAUDE, harness: 'acp', canSignIn: false }
    const said = signInsOf([{ ...CLAUDE, status: { ...CLAUDE.status, who: TOKEN } }, keyPaid, none])
    expect(said).toEqual([
      {
        harness: 'claude-code',
        account: null,
        signedIn: true,
        until: Date.UTC(2026, 10, 1),
        problem: null,
      },
    ])
    expect(JSON.stringify(said)).not.toContain(TOKEN)
  })
})
