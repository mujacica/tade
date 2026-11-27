import { afterEach, describe, expect, it } from 'vitest'
import {
  type AccountAway,
  type AccountSignInCall,
  type AccountSignInStanding,
  type AccountsAnswer,
  type AccountsCall,
  accountsAnswerOf,
  forwardedCall,
  signInStandingOf,
  type WebAccounts,
} from '../src/accounts.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// Settings › Accounts for every machine, asked from the person's own phone
// (`accounts.ts`): a paired phone's and an owner's, a look
// or one of six presses and nothing else, each handed to the window's half
// parsed and as the device's — and what another machine answers, read back
// bounded, so nothing it says reaches the phone but the fields Tade writes.

afterEach(closeAll)

const ONE: AccountAway = {
  harness: 'claude-code',
  title: 'Claude Code',
  name: null,
  ownName: null,
  kind: 'subscription',
  canAdd: true,
  why: null,
  signedIn: true,
  who: 'me@example.com',
  plan: 'Max',
  problem: null,
  windows: [{ label: '5h', minutes: 300, used: 42 }],
  agents: 1,
  forNewAgents: true,
  projects: [],
  canSignIn: true,
  install: null,
}

const ANSWER: AccountsAnswer = {
  machine: null,
  machines: [{ id: null, label: 'laptop' }],
  accounts: [ONE],
  said: null,
  trouble: false,
  keys: 'An agent runs as you, whichever sign-in it is on.',
}

const STANDING: AccountSignInStanding = {
  state: 'running',
  who: 'work',
  how: 'Claude Code prints a link.',
  rows: ['Paste code here if prompted >'],
  link: 'https://claude.ai/oauth/authorize?code=true',
  said: null,
  about: 'claude-code:work',
}

/** A window half recording every call, as it was handed over. */
function half(): WebAccounts & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    carry: async (call: AccountsCall, device: string) => {
      calls.push(['carry', call, device])
      return ANSWER
    },
    signIn: async (call: AccountSignInCall, device: string) => {
      calls.push(['signIn', call, device])
      return STANDING
    },
  }
}

function post(one: Running, device: Awaited<ReturnType<typeof pair>>, path: string, body: unknown) {
  return ask(one, path, {
    method: 'POST',
    headers: {
      origin: one.origin,
      cookie: device.cookie,
      'content-type': 'application/json',
      [CSRF_HEADER]: device.csrf,
    },
    body: JSON.stringify(body),
  })
}

/** A paired phone: every one is the person's own. */
function theirs(one: Running) {
  return pair(one, { label: 'mine' })
}

describe('a machine’s accounts, asked from the person’s own phone', () => {
  it('hands each look and press to the window parsed, as the device’s, and answers what it says', async () => {
    const accounts = half()
    const one = await start({}, { owned: { accounts } })
    const phone = await theirs(one)
    const calls = [
      { do: 'look' },
      { machine: 'ipax', do: 'look' },
      { do: 'use', harness: 'claude-code', account: null },
      { machine: 'ipax', do: 'sign-out', harness: 'claude-code', account: 'work' },
      { do: 'add', harness: 'claude-code', name: 'work', kind: 'subscription' },
      { do: 'remove', account: 'work' },
      { do: 'name', harness: 'claude-code', name: '' },
      { do: 'key', account: 'ci', key: 'sk-test' },
    ]
    for (const body of calls) {
      const said = await post(one, phone, '/api/accounts', body)
      expect(said.status, said.text).toBe(200)
      expect(JSON.parse(said.text)).toEqual(ANSWER)
    }
    expect(accounts.calls).toEqual(calls.map((call) => ['carry', call, phone.device]))
  })

  it('hands an account’s sign-in to the window, on the machine it names', async () => {
    const accounts = half()
    const one = await start({}, { owned: { accounts } })
    const phone = await theirs(one)
    const whose = { machine: 'ipax', harness: 'claude-code', account: 'work' }
    const calls = [
      { ...whose, do: 'start' },
      { ...whose, do: 'look' },
      { ...whose, do: 'type', text: 'abc#def' },
      { ...whose, do: 'key', key: 'down' },
      { harness: 'pi', account: null, do: 'cancel' },
    ]
    for (const body of calls) {
      const said = await post(one, phone, '/api/accounts/sign-in', body)
      expect(said.status, said.text).toBe(200)
      expect(JSON.parse(said.text)).toEqual(STANDING)
    }
    expect(accounts.calls).toEqual(calls.map((call) => ['signIn', call, phone.device]))
  })

  it('takes nothing else, and is the 404 of a path nobody wired', async () => {
    const accounts = half()
    const one = await start({}, { owned: { accounts } })
    const mine = await theirs(one)
    for (const body of [
      {},
      { do: 'look', extra: 1 },
      { do: 'run', command: 'sh' },
      { do: 'use', harness: 'claude-code' },
      { do: 'add', harness: 'claude-code', name: 'work', kind: 'token' },
      { do: 'add', harness: 'claude-code', name: '', kind: 'subscription' },
      { do: 'remove', account: 'x'.repeat(65) },
      { do: 'key', account: 'ci', key: 'k'.repeat(4097) },
      { machine: '', do: 'look' },
      { machine: null, do: 'look' },
    ]) {
      expect((await post(one, mine, '/api/accounts', body)).status, JSON.stringify(body)).toBe(400)
    }
    for (const body of [
      { do: 'start' },
      { harness: 'claude-code', account: null, do: 'type', text: '' },
      { harness: 'claude-code', account: null, do: 'key', key: 'ctrl-c' },
      { harness: 'claude-code', do: 'start' },
    ]) {
      const said = await post(one, mine, '/api/accounts/sign-in', body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    expect(accounts.calls).toEqual([])
    const none = await start()
    const nobody = await theirs(none)
    expect((await post(none, nobody, '/api/accounts', { do: 'look' })).status).toBe(404)
    for (const name of ['accounts', 'accounts sign-in']) {
      expect(OWNED.find((route) => route.name === name)).toMatchObject({
        method: 'POST',
        here: true,
        mutates: true,
      })
    }
  })
})

describe('what another machine answers, read back', () => {
  it('sends a call on to the machine it names as that machine’s own, naming none', () => {
    expect(forwardedCall({ machine: 'ipax', do: 'look' })).toEqual({ do: 'look' })
    expect(
      forwardedCall({ machine: 'ipax', do: 'use', harness: 'claude-code', account: null }),
    ).toEqual({ do: 'use', harness: 'claude-code', account: null })
  })

  it('keeps only the fields Tade writes, and is null for an answer that is not one', () => {
    const extra = { ...ANSWER, accounts: [{ ...ONE, token: 'secret' }], html: '<script>' }
    const read = accountsAnswerOf(extra)
    expect(read).toEqual({ accounts: [ONE], said: null, trouble: false })
    expect(JSON.stringify(read)).not.toContain('secret')
    expect(accountsAnswerOf({ ...ANSWER, accounts: null, said: 'down' })).toEqual({
      accounts: null,
      said: 'down',
      trouble: false,
    })
    expect(accountsAnswerOf(null)).toBeNull()
    expect(accountsAnswerOf({ error: 'no_such' })).toBeNull()
    expect(
      accountsAnswerOf({ ...ANSWER, accounts: [{ ...ONE, harness: 'x'.repeat(65) }] }),
    ).toBeNull()
    expect(accountsAnswerOf({ ...ANSWER, said: 'x'.repeat(2001) })).toBeNull()
    const many = Array.from({ length: 201 }, () => ONE)
    expect(accountsAnswerOf({ ...ANSWER, accounts: many })).toBeNull()
  })

  it('reads a sign-in’s standing back bounded, its screen and link kept to their limits', () => {
    expect(signInStandingOf({ ...STANDING, cookie: 'x' })).toEqual(STANDING)
    expect(signInStandingOf({ ...STANDING, state: 'stolen' })).toBeNull()
    expect(signInStandingOf({ ...STANDING, rows: ['x'.repeat(4097)] })).toBeNull()
    expect(signInStandingOf({ ...STANDING, link: 'x'.repeat(4097) })).toBeNull()
    expect(signInStandingOf({ ...STANDING, about: undefined })).toBeNull()
    expect(signInStandingOf('nope')).toBeNull()
  })
})
