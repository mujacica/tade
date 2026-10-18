import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyDigest, type SettingGroup } from '@tade/core'
import { digestOf, GRANTS, SCOPES, writeDevices } from '@tade/web'
import type { AccountView } from '@tade/workbench/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { signInsOf, waitingHere } from '../../src/wire/web-carry.ts'
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
  projects: [],
  forOrchestrator: null,
  canSignIn: true,
  provider: 'anthropic',
  install: null,
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

  it('writes a key sent on the press, and its line says only that one is set', async () => {
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
    expect(changed[0]?.detail).toMatchObject({ now: 'set', carried: 'mac' })
    expect(JSON.stringify(changed)).not.toContain('jev-0123456789')
  })

  it('says back what it reads only when it next starts, carry after carry until it does', async () => {
    const one = await machine({ realKeys: true, accounts: async () => [] })
    await owner(one.home, one.port)
    await one.away.open()
    const body = {
      from: 'mac',
      complete: false,
      settings: [
        { path: 'notes.keep_days', value: 9 },
        { path: 'agents.commit', value: 'as-you-go' },
      ],
    }
    const first = await carried(one.port, body)
    expect(first.body.settings).toEqual([
      { path: 'notes.keep_days', outcome: 'written', nextStart: true },
      { path: 'agents.commit', outcome: 'written' },
    ])
    // Already so the next time, and still not in use: this window opened before it was.
    await waitFor(one.client, 'config_changed')
    const again = await carried(one.port, body)
    expect(again.body.settings).toEqual([
      { path: 'notes.keep_days', outcome: 'same', nextStart: true },
      { path: 'agents.commit', outcome: 'same' },
    ])
  })

  it('says in the conversation where the line that marks it carried could not be written', async () => {
    const one = await machine({ realKeys: true, accounts: async () => [] })
    await owner(one.home, one.port)
    await one.away.open()
    const append = one.client.log.append.bind(one.client.log)
    const refusing = vi.spyOn(one.client.log, 'append').mockImplementation(async (line) => {
      if (line.type === 'config_changed') throw new Error('ENOSPC: no space left on device')
      return append(line)
    })
    try {
      const answer = await carried(one.port, {
        from: 'mac',
        complete: false,
        settings: [{ path: 'agents.commit', value: 'as-you-go' }],
      })
      expect(answer.body.settings).toEqual([{ path: 'agents.commit', outcome: 'written' }])
    } finally {
      refusing.mockRestore()
    }
    expect(fileOf(one.home).agents?.commit).toBe('as-you-go')
    // Without the line, the next carry reads the value as changed here: said, never dropped.
    const said = one
      .transcript()
      .entries.flatMap((entry) => (entry.kind === 'tade' ? [entry.text] : []))
    expect(said).toEqual([
      'agents.commit is written, but the journal would not take the line that says so (ENOSPC: no space left on device), so the next carry from mac reads it as changed here and leaves it.',
    ])
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

describe('what waits for Tade to start again here', () => {
  it('is a row Settings says is not live, and one of yours that is on and not running', () => {
    const rows = [
      {
        settings: [
          { path: 'notes.keep_days', live: false, type: { kind: 'number' } },
          { path: 'agents.commit', live: true, type: { kind: 'choice' } },
        ],
      },
    ] as unknown as SettingGroup[]
    const waiting = waitingHere(
      [
        'notes.keep_days',
        'agents.commit',
        'extensions.mine.enabled',
        'extensions.idle.enabled',
        'extensions.jev.enabled',
        'extensions.mcp-docs.enabled',
        'extensions.gone.enabled',
        'prices',
      ],
      rows,
      {
        extensions: {
          mine: { enabled: true },
          idle: {},
          jev: { enabled: true },
          'mcp-docs': { enabled: true },
        },
        mcp: { servers: {} },
      },
      [
        { name: 'mine', source: 'yours', state: 'off' },
        { name: 'idle', source: 'yours', state: 'off' },
        { name: 'jev', source: 'built-in', state: 'ready' },
        { name: 'mcp-docs', source: 'mcp', state: 'off' },
      ],
    )
    expect([...waiting]).toEqual(['notes.keep_days', 'extensions.mine.enabled'])
  })

  // The broker is made once, as the window opens (`brokerFor`), so a server
  // turned on there connects at the next start, and one it already has goes on
  // as it was until then when changed — but one turned off is off at once.
  it('is an MCP server that is on, and never one turned off, running or not', () => {
    const waiting = waitingHere(
      ['mcp.servers.new', 'mcp.servers.docs', 'mcp.servers.linear', 'mcp.servers.idle'],
      [],
      {
        extensions: {},
        mcp: {
          servers: {
            new: { enabled: true },
            docs: { enabled: true, url: 'https://docs.example/mcp' },
            linear: { enabled: false },
            idle: { enabled: false, about: 'tried once' },
          },
        },
      },
      [
        { name: 'mcp-docs', source: 'mcp', state: 'ready' },
        { name: 'mcp-linear', source: 'mcp', state: 'ready' },
      ],
    )
    expect([...waiting]).toEqual(['mcp.servers.new', 'mcp.servers.docs'])
  })

  it('is a provider changed alone, by the model row that writes it', () => {
    const rows = [
      {
        settings: [
          { path: 'orchestrator.model', live: false, type: { kind: 'model', harness: 'pi' } },
          {
            path: 'workers.routes.default.model',
            live: true,
            type: { kind: 'model', harness: 'pi' },
          },
        ],
      },
    ] as unknown as SettingGroup[]
    const waiting = waitingHere(
      ['orchestrator.provider', 'workers.routes.default.provider'],
      rows,
      { extensions: {}, mcp: { servers: {} } },
      [],
    )
    expect([...waiting]).toEqual(['orchestrator.provider'])
  })
})

describe('talking to Tade from another screen, turned on from the machine that owns it', () => {
  it('is said back as off, and turned on by the window’s own door once the answer has gone', async () => {
    const one = await machine({ realKeys: true, accounts: async () => [] })
    await owner(one.home, one.port)
    await one.away.open()
    const body = { from: 'mac', complete: false, settings: [] }
    const told = await carried(one.port, body)
    expect(told.body.talk).toBe('off')
    const pressed = await carried(one.port, { ...body, talk: true })
    expect(pressed.status).toBe(200)
    expect(pressed.body.talk).toBe('turning on')
    const changed = await waitFor(one.client, 'config_changed')
    expect(changed.map((line) => line.detail)).toEqual([
      { path: 'surfaces.web.orchestrator', was: 'false', now: 'true', by: `device ${DEVICE}` },
    ])
    const file = parse(readFileSync(join(one.home, 'config.yaml'), 'utf8')) as {
      surfaces?: { web?: { orchestrator?: boolean } }
    }
    expect(file.surfaces?.web?.orchestrator).toBe(true)
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
