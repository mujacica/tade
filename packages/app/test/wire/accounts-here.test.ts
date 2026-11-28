import { ConfigSchema, KEYS_AND_AGENTS } from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import { awaitAccount, requestAccount } from '@tade/workbench/account-requests'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { AccountsHere } from '../../src/wire/accounts-here.ts'
import type { Wiring } from '../../src/wire/context.ts'

// Settings › Accounts for this machine and every one it links to, as this
// window answers its door (`/api/accounts`): for the person's own phone, and
// for another of their machines' window drawing this one's tab. This
// machine's through the workbench's own acts; another's asked over the link
// to it and answered with what it said; and what a terminal beside a running
// `tade serve` asked, done on the beat.
//
// Built by hand, as `web-sign-in.test.ts` beside it is: what this subject does
// is ask the client and the link, and a real window answers that with a real
// PTY and a real machine.

const VIEW = {
  harness: 'claude-code',
  name: 'work',
  ownName: null,
  kind: 'subscription' as const,
  canAdd: true,
  why: null,
  status: { signedIn: true, who: 'amir@example.com', plan: 'Max', problem: null },
  limits: { windows: [{ minutes: 300, used: 42 }] },
  agents: 2,
  forNewAgents: true,
  projects: ['shop'],
  forOrchestrator: false,
  canSignIn: true,
  provider: 'anthropic',
  install: null,
}

const IPAX = {
  ssh: 'ipax',
  tade: 'tade',
  device: '00112233445566aa',
  session: `00112233445566aa.${'s'.repeat(20)}`,
  csrf: 'c'.repeat(20),
  host: 'localhost:7654',
}

/** A window linked to ipax, and everything it asked of the world. */
function world(over: { refuse?: string; answer?: Answer | Error; noReach?: boolean } = {}) {
  const did: { what: string; with: unknown[] }[] = []
  const journal: unknown[] = []
  const home = tmp('tade-accounts-here-')
  let state: AppState = initialState()
  const now = 1_000
  const act =
    (what: string, returns: unknown = undefined) =>
    async (...args: unknown[]) => {
      did.push({ what, with: args })
      if (over.refuse === what) throw new Error(`${what} refused`)
      return returns
    }
  const client = {
    accounts: async () => [VIEW],
    useAccount: act('useAccount'),
    signOut: act('signOut'),
    addAccount: act('addAccount'),
    removeAccount: act('removeAccount'),
    nameOwnSignIn: async (harness: string, name: string | null) => {
      did.push({ what: 'nameOwnSignIn', with: [harness, name] })
      return name
    },
    saveAccountKey: act('saveAccountKey', 'config.yaml'),
    log: { append: async (line: unknown) => void journal.push(line) },
  }
  const wire = {
    opts: {
      config: ConfigSchema.parse({
        projects: { shop: { root: '/tmp/shop' } },
        remotes: { ipax: IPAX },
      }),
      home,
      client,
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => now,
    draw: () => {},
    note: (err: unknown) => did.push({ what: 'note', with: [String(err)] }),
  } as unknown as Wiring
  const subject = new AccountsHere(wire, {
    use: () => did.push({ what: 'use', with: [] }),
    reread: () => did.push({ what: 'reread', with: [] }),
  })
  if (!over.noReach) {
    subject.withReach((name) =>
      name === 'ipax'
        ? {
            live: true,
            remote: { name: 'ipax' } as never,
            link: {
              call: async (_remote: unknown, path: string, body: unknown) => {
                did.push({ what: 'call', with: [path, body] })
                if (over.answer instanceof Error) throw over.answer
                return (
                  over.answer ?? {
                    status: 200,
                    body: { accounts: [], said: 'ok there', trouble: false },
                  }
                )
              },
            } as never,
          }
        : null,
    )
  }
  return {
    subject,
    did,
    journal,
    home,
  }
}

/** Every promise the subject left running, settled. */
const settle = () => new Promise((done) => setTimeout(done, 0))

describe('this machine’s accounts, at its door', () => {
  it('says every harness’s sign-ins with the plan used, and every machine with a tab', async () => {
    const { subject } = world()
    const answer = await subject.carry({ do: 'look' }, 'phone1')
    expect(answer.machine).toBeNull()
    expect(answer.machines.map((one) => one.id)).toEqual([null, 'ipax'])
    expect(answer.said).toBeNull()
    expect(answer.keys).toBe(KEYS_AND_AGENTS)
    expect(answer.accounts).toEqual([
      {
        harness: 'claude-code',
        title: 'Claude Code',
        name: 'work',
        ownName: null,
        kind: 'subscription',
        canAdd: true,
        why: null,
        signedIn: true,
        who: 'amir@example.com',
        plan: 'Max',
        problem: null,
        windows: [{ label: '5h', minutes: 300, used: 42 }],
        agents: 2,
        forNewAgents: true,
        projects: ['shop'],
        canSignIn: true,
        install: null,
      },
    ])
  })

  it('carries a press out with the workbench’s own act, the window following what it wrote, written down as the device’s', async () => {
    const { subject, did, journal } = world()
    const answer = await subject.carry(
      { do: 'use', harness: 'claude-code', account: 'work' },
      'phone1',
    )
    expect(answer.said).toBe('New Claude Code agents run as work.')
    expect(answer.trouble).toBe(false)
    expect(did).toEqual([
      { what: 'useAccount', with: ['claude-code', 'work'] },
      { what: 'use', with: [] },
      { what: 'reread', with: [] },
    ])
    await settle()
    expect(journal).toEqual([
      { type: 'web_did', detail: { device: 'phone1', verb: 'account use', state: 'done' } },
    ])
    await subject.carry({ do: 'add', harness: 'claude-code', name: 'Ci', kind: 'api-key' }, 'p')
    await subject.carry({ do: 'key', account: 'ci', key: 'sk-test' }, 'p')
    await subject.carry({ do: 'name', harness: 'claude-code', name: '' }, 'p')
    expect(did.filter((one) => !['use', 'reread'].includes(one.what))).toEqual([
      { what: 'useAccount', with: ['claude-code', 'work'] },
      { what: 'addAccount', with: [{ name: 'Ci', harness: 'claude-code', kind: 'api-key' }] },
      { what: 'saveAccountKey', with: ['ci', 'sk-test'] },
      // An empty name takes the name away.
      { what: 'nameOwnSignIn', with: ['claude-code', null] },
    ])
    // A key typed on the phone is never written down.
    expect(JSON.stringify(journal)).not.toContain('sk-test')
  })

  it('says what the workbench refused as trouble, with the accounts as they are', async () => {
    const { subject, journal } = world({ refuse: 'removeAccount' })
    const answer = await subject.carry({ do: 'remove', account: 'work' }, 'phone1')
    expect(answer).toMatchObject({ said: 'removeAccount refused', trouble: true })
    expect(answer.accounts).toHaveLength(1)
    await settle()
    expect(journal).toEqual([
      { type: 'web_did', detail: { device: 'phone1', verb: 'account remove', state: 'failed' } },
    ])
  })
})

describe('another machine’s accounts, through this one’s door', () => {
  it('asks it over the link as its own call, naming no machine, and answers with this machine’s tabs', async () => {
    const { subject, did } = world({
      answer: { status: 200, body: { accounts: null, said: 'refused there', trouble: true } },
    })
    const answer = await subject.carry(
      { machine: 'ipax', do: 'sign-out', harness: 'claude-code', account: null },
      'phone1',
    )
    expect(did).toEqual([
      {
        what: 'call',
        with: ['/api/accounts', { do: 'sign-out', harness: 'claude-code', account: null }],
      },
    ])
    expect(answer).toEqual({
      machine: 'ipax',
      machines: [
        { id: null, label: expect.any(String) },
        { id: 'ipax', label: 'ipax' },
      ],
      accounts: null,
      said: 'refused there',
      trouble: true,
      keys: KEYS_AND_AGENTS,
    })
  })

  it('says why it could not be asked, rather than drawing it with nothing', async () => {
    const older = await world({ answer: { status: 404, body: null } }).subject.carry(
      { machine: 'ipax', do: 'look' },
      'p',
    )
    expect(older.said).toContain('older than this one')
    expect(older.trouble).toBe(true)
    const down = await world({ answer: new Error('timed out') }).subject.carry(
      { machine: 'ipax', do: 'look' },
      'p',
    )
    expect(down.said).toBe('ipax could not be asked: timed out')
    const stranger = await world().subject.carry({ machine: 'nope', do: 'look' }, 'p')
    expect(stranger.said).toBe('No machine called nope is linked here.')
    const unlinked = await world({ noReach: true }).subject.carry(
      { machine: 'ipax', do: 'look' },
      'p',
    )
    expect(unlinked.said).toContain('its link is not open')
    // An answer in a shape Tade does not write is not passed on as one.
    const odd = await world({
      answer: { status: 200, body: { accounts: 'all of them' } },
    }).subject.carry({ machine: 'ipax', do: 'look' }, 'p')
    expect(odd).toMatchObject({ accounts: null, trouble: true, said: 'ipax answered 200.' })
  })
})

describe('what a terminal beside `tade serve` asked of the accounts', () => {
  it('is done on the beat with the workbench’s own act, answered, and the window follows it', async () => {
    const { subject, did, home } = world()
    const id = await requestAccount(home, { do: 'use', harness: 'claude-code', account: 'work' })
    const waiting = awaitAccount(home, id, { takeMs: 2_000, doMs: 2_000, everyMs: 10 })
    await subject.takeRequests()
    expect(await waiting).toEqual({ ok: true, named: 'work' })
    expect(did).toEqual([
      { what: 'useAccount', with: ['claude-code', 'work', undefined] },
      { what: 'use', with: [] },
      { what: 'reread', with: [] },
    ])
  })
})
