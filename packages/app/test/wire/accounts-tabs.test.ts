import { ConfigSchema } from '@tade/core'
import type { AccountAway, AccountsCall } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { type AppState, initialState } from '../../src/model.ts'
import { ACCOUNTS, settingsPanel } from '../../src/panels/settings/state.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Machine } from '../../src/wire/machine.ts'

// Settings › Accounts as the one place every machine's accounts are managed:
// a tab for this machine, then one for every machine it links to, each with
// that machine's sign-ins and the presses on them — carried out there, over
// this machine's link (`AccountsHere`), its sign-in in a terminal there.
//
// Built by hand, as `machine.test.ts` beside it is: what is under test is
// which machine each press reaches, and the door and the terminal are the
// deps' to answer.

/** One account another machine said it has. */
const away = (over: Partial<AccountAway> = {}): AccountAway => ({
  harness: 'claude-code',
  title: 'Claude Code',
  name: null,
  ownName: null,
  kind: 'subscription',
  canAdd: true,
  why: null,
  signedIn: true,
  who: 'amir@example.com',
  plan: 'Max',
  problem: null,
  windows: [{ label: '5h', minutes: 300, used: 42 }],
  agents: 1,
  forNewAgents: true,
  projects: [],
  canSignIn: true,
  install: null,
  ...over,
})

/** A window linked to ipax, and every press that reached anywhere. */
function world(over: { there?: AccountAway[] | null; said?: string; trouble?: boolean } = {}) {
  const did: { what: string; with: unknown[] }[] = []
  let state: AppState = initialState()
  const client = {
    async accounts() {
      did.push({ what: 'accounts here', with: [] })
      return [
        {
          harness: 'claude-code',
          name: null,
          ownName: null,
          kind: 'subscription',
          canAdd: true,
          why: null,
          provider: 'anthropic',
          status: { signedIn: true, who: 'here@example.com', plan: null, problem: null },
          limits: null,
          agents: 0,
          forNewAgents: true,
          projects: [],
          forOrchestrator: null,
          canSignIn: true,
          install: null,
        },
      ]
    },
    async useAccount(...args: unknown[]) {
      did.push({ what: 'useAccount here', with: args })
    },
    async addAccount(...args: unknown[]) {
      did.push({ what: 'addAccount here', with: args })
    },
  }
  const wire = {
    opts: {
      config: ConfigSchema.parse({
        projects: { shop: { root: '/tmp/shop' } },
        remotes: {
          ipax: {
            ssh: 'ipax',
            tade: 'tade',
            device: '00112233445566aa',
            session: `00112233445566aa.${'s'.repeat(20)}`,
            csrf: 'c'.repeat(20),
            host: 'localhost:7654',
          },
        },
      }),
      home: '/tmp/home',
      client,
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => 1_000,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  let answers = 0
  const subject = new Machine(wire, {
    reload: () => {},
    terminalSize: () => ({ cols: 100, rows: 30 }),
    showTerminal: async () => {},
    onScreenWith: async () => {},
    refreshModels: async () => {},
    writeSetting: async () => 'Saved.',
    signInThere: async () => {},
    restartOrchestrator: () => {},
    accountsThere: () => ({
      tabs: () => [
        { id: null, label: 'laptop' },
        { id: 'ipax', label: 'ipax' },
      ],
      carry: async (call: AccountsCall, device: string) => {
        did.push({ what: 'carry', with: [call, device] })
        answers += 1
        return {
          accounts:
            over.there === undefined
              ? [away(), away({ name: 'work', forNewAgents: false })]
              : over.there,
          said: over.said ?? (call.do === 'look' ? null : `did ${call.do} on ipax`),
          trouble: over.trouble ?? false,
        }
      },
    }),
    signInAccountThere: async (machine, harness, account) => {
      did.push({ what: 'signInAccountThere', with: [machine, harness, account] })
    },
  })
  const onTab = (tab: string) => {
    state = { ...state, panel: settingsPanel(ACCOUNTS, '', tab) }
  }
  return { subject, did, onTab, at: () => state, answers: () => answers }
}

/** Every promise the subject left running, settled. */
const settle = () => new Promise((done) => setTimeout(done, 0))

describe('Settings › Accounts, a tab for every machine', () => {
  it('is this machine’s first and then every machine it links to, and this one is as it always was', async () => {
    const { subject, did, onTab } = world()
    onTab('')
    await subject.loadAccountViews()
    expect(subject.panel()?.accountTabs).toEqual([
      { id: '', label: 'laptop' },
      { id: 'ipax', label: 'ipax' },
    ])
    expect(subject.inputs().accountTabs).toEqual(['', 'ipax'])
    // This machine's presses are this machine's: no machine on their ids.
    const ids = subject.inputs().accountActions.map((one) => one.id)
    expect(ids).toContain('account:add:claude-code:')
    expect(ids.every((id) => id.split(':').length === 4)).toBe(true)
    expect(did.some((one) => one.what === 'carry')).toBe(false)
  })

  it('draws no tabs for a machine with no others', async () => {
    const { subject, onTab } = world()
    onTab('')
    const alone = new Machine(
      {
        opts: { config: ConfigSchema.parse({}), client: { accounts: async () => [] } },
        state: { ...initialState(), panel: settingsPanel(ACCOUNTS) },
        draw: () => {},
      } as unknown as Wiring,
      {
        accountsThere: () => ({
          tabs: () => [{ id: null, label: 'laptop' }],
          carry: async () => ({}) as never,
        }),
      } as never,
    )
    expect(alone.panel()?.accountTabs).toEqual([])
    expect(alone.inputs().accountTabs).toEqual([])
    expect(subject.panel()?.accountTabs).toHaveLength(2)
  })

  it('asks another machine when its tab is drawn, and draws what it said, once', async () => {
    const { subject, did, onTab } = world()
    onTab('ipax')
    expect(subject.panel()).toMatchObject({
      accounts: [],
      accountsSaid: 'Asking ipax who its harnesses are signed in as…',
    })
    await settle()
    expect(did.filter((one) => one.what === 'carry')).toEqual([
      { what: 'carry', with: [{ machine: 'ipax', do: 'look' }, 'window'] },
    ])
    const drawn = subject.panel()?.accounts ?? []
    expect(drawn.map((one) => [one.name, one.status.who, one.limits?.windows])).toEqual([
      [null, 'amir@example.com', [{ minutes: 300, used: 42 }]],
      ['work', 'amir@example.com', [{ minutes: 300, used: 42 }]],
    ])
    // Drawn again, it is not asked again until something makes it stale.
    subject.panel()
    await settle()
    expect(did.filter((one) => one.what === 'carry')).toHaveLength(1)
    // Settings opened again asks every machine again, the next time its tab is drawn.
    await subject.loadAccountViews()
    subject.panel()
    await settle()
    expect(did.filter((one) => one.what === 'carry')).toHaveLength(2)
  })

  it('names that machine on every press of its tab, and the orchestrator’s is not one of them', async () => {
    const { subject, onTab } = world()
    onTab('ipax')
    subject.panel()
    await settle()
    const ids = subject.inputs().accountActions.map((one) => one.id)
    expect(ids).toContain('account:use:claude-code:work:ipax')
    expect(ids).toContain('account:sign-in:claude-code::ipax')
    expect(ids).toContain('account:add:claude-code::ipax')
    expect(ids.every((id) => id.endsWith(':ipax'))).toBe(true)
    // Which account the orchestrator there runs as is that machine's to set.
    expect(ids.some((id) => id.startsWith('account:orchestrator:'))).toBe(false)
  })

  it('carries a press out there, and says what it did on the page, touching nothing here', async () => {
    const { subject, did, onTab, at } = world()
    onTab('ipax')
    await subject.accountAction('account:use:claude-code:work:ipax')
    expect(did).toEqual([
      {
        what: 'carry',
        with: [{ machine: 'ipax', do: 'use', harness: 'claude-code', account: 'work' }, 'window'],
      },
    ])
    const panel = at().panel
    expect(panel?.kind === 'settings' && [panel.saved, panel.error, panel.scope]).toEqual([
      'did use on ipax',
      null,
      'ipax',
    ])
  })

  it('says what that machine refused as trouble, and keeps what it last said', async () => {
    const refusing = world({ said: 'work runs app/fix: stop it first', trouble: true })
    refusing.onTab('ipax')
    await refusing.subject.accountAction('account:remove:claude-code:work:ipax')
    const panel = refusing.at().panel
    expect(panel?.kind === 'settings' && [panel.saved, panel.error]).toEqual([
      null,
      'work runs app/fix: stop it first',
    ])
    // A machine that could not be asked at all: why, where its accounts would be.
    const down = world({ there: null, said: 'ipax could not be asked: timed out', trouble: true })
    down.onTab('ipax')
    down.subject.panel()
    await settle()
    expect(down.subject.panel()).toMatchObject({
      accounts: [],
      accountsSaid: 'ipax could not be asked: timed out',
    })
  })

  it('signs one in with its harness’s own sign-in there, in a terminal over the link, and asks again', async () => {
    const { subject, did, onTab } = world()
    onTab('ipax')
    await subject.accountAction('account:sign-in:claude-code:work:ipax')
    expect(did.map((one) => one.what)).toEqual(['signInAccountThere', 'carry'])
    expect(did[0]?.with).toEqual(['ipax', 'claude-code', 'work'])
    expect(did[1]?.with[0]).toEqual({ machine: 'ipax', do: 'look' })
  })

  it('adds one there by the name asked for, then goes straight into its sign-in there', async () => {
    const { subject, did, onTab, at } = world()
    onTab('ipax')
    await subject.accountAction('account:add:claude-code::ipax')
    const asking = at().panel
    expect(asking?.kind).toBe('prompt')
    if (asking?.kind !== 'prompt') return
    expect(asking.title).toBe('Add a Claude Code account on ipax')
    await subject.prompts()['account-name']?.(asking, 'Work', undefined)
    expect(did).toEqual([
      {
        what: 'carry',
        with: [
          {
            machine: 'ipax',
            do: 'add',
            harness: 'claude-code',
            name: 'work',
            kind: 'subscription',
          },
          'window',
        ],
      },
      { what: 'signInAccountThere', with: ['ipax', 'claude-code', 'work'] },
      { what: 'carry', with: [{ machine: 'ipax', do: 'look' }, 'window'] },
    ])
    // Back on that machine's tab, never this one's.
    const back = at().panel
    expect(back?.kind === 'settings' && back.scope).toBe('ipax')
  })

  it('takes an API-key account’s key there, against the account and machine it was asked for', async () => {
    const { subject, did, onTab, at } = world()
    onTab('ipax')
    await subject.accountAction('account:add-key:claude-code::ipax')
    const asking = at().panel
    if (asking?.kind !== 'prompt') throw new Error('no prompt')
    await subject.prompts()['account-name']?.(asking, 'ci', undefined)
    const key = at().panel
    if (key?.kind !== 'prompt') throw new Error('no key prompt')
    expect(key.title).toBe("ci's API key on ipax")
    await subject.prompts()['account-key']?.(key, 'sk-test', undefined)
    expect(did.map((one) => one.with[0])).toEqual([
      { machine: 'ipax', do: 'add', harness: 'claude-code', name: 'ci', kind: 'api-key' },
      { machine: 'ipax', do: 'key', account: 'ci', key: 'sk-test' },
    ])
    // Nothing signs in an account paid for with a key.
    expect(did.some((one) => one.what === 'signInAccountThere')).toBe(false)
  })
})
