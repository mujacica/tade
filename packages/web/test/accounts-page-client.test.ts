import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement, StillEvent } from '../scripts/still-dom.ts'
import type { AccountAway, AccountsAnswer } from '../src/accounts.ts'
import { AccountSignInCall, AccountsCall } from '../src/accounts.ts'
import { accountsScreen } from '../src/assets/pages/accounts.js'
import {
  ACCOUNT_SIGN_IN_PATH,
  ACCOUNTS_PATH,
  accountName,
  accountSignInSaid,
  addsOf,
  askedOf,
  emptySaid,
  harnessesOf,
  lookBody,
  pressBody,
  pressesOf,
  signInHeading,
  signInWith,
  statusSaid,
  tabHere,
  tabSaid,
  tabsOf,
  whoseSaid,
  windowsSaid,
} from '../src/assets/pages/accounts-shape.js'
import { OWNED } from '../src/routes.ts'

// What the Accounts page draws and sends (`pages/accounts-shape.js`), against
// the answer the person's own phone is sent (`accounts.ts`): a tab per
// machine, this one first and none for one machine; each account's sign-in,
// plan and windows in words; the presses the window's own page offers, when it
// offers them; and every body a press sends one the door parses — naming the
// machine only on another machine's tab.

/** One account, signed in, with a plan and two windows: Claude Code's own sign-in. */
const OWN: AccountAway = {
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
  windows: [
    { label: '5h', minutes: 300, used: 41.6 },
    { label: '7d', minutes: 10_080, used: 10 },
  ],
  agents: 2,
  forNewAgents: true,
  projects: [],
  canSignIn: true,
  install: null,
}

/** An account added beside it, not signed in, that one project runs as. */
const WORK: AccountAway = {
  ...OWN,
  name: 'work',
  signedIn: false,
  who: null,
  plan: null,
  problem: null,
  windows: [],
  agents: 0,
  forNewAgents: false,
  projects: ['shop'],
}

/** pi, which keeps one account and says why. */
const PI: AccountAway = {
  ...OWN,
  harness: 'pi',
  title: 'pi',
  canAdd: false,
  why: 'keeps one account',
  windows: [],
  agents: 0,
}

/** An API-key account, its key set. */
const KEYED: AccountAway = { ...WORK, name: 'ci', kind: 'api-key', signedIn: true, projects: [] }

const ANSWER: AccountsAnswer = {
  machine: null,
  machines: [
    { id: null, label: 'laptop' },
    { id: 'ipax', label: 'ipax' },
  ],
  accounts: [OWN, WORK, PI],
  said: null,
  trouble: false,
  keys: 'An agent runs as you, whichever sign-in it is on.',
}

describe('the Accounts page’s tabs', () => {
  it('is a tab per machine, this one first and said to be here; none for one machine', () => {
    expect(tabsOf(ANSWER)).toEqual([
      { id: null, label: 'laptop' },
      { id: 'ipax', label: 'ipax' },
    ])
    expect(tabsOf({ ...ANSWER, machines: [{ id: null, label: 'laptop' }] })).toEqual([])
    expect(tabsOf(null)).toEqual([])
    expect(tabSaid({ id: null, label: 'laptop' })).toBe('laptop · here')
    expect(tabSaid({ id: 'ipax', label: 'ipax' })).toBe('ipax')
  })

  it('goes back to this machine’s tab where the one chosen is not a tab any more', () => {
    expect(tabHere('ipax', ANSWER)).toBe('ipax')
    expect(tabHere('gone', ANSWER)).toBeNull()
    expect(tabHere(null, ANSWER)).toBeNull()
  })
})

describe('an account, as its card says it', () => {
  it('says who it is signed in as and the plan, or what is wrong, or that a key pays for it', () => {
    expect(statusSaid(OWN)).toBe('● me@example.com · Max')
    expect(statusSaid(WORK)).toBe('○ not signed in')
    expect(statusSaid({ ...WORK, problem: 'Claude Code is not installed' })).toBe(
      '○ Claude Code is not installed',
    )
    expect(statusSaid(KEYED)).toBe('● paid with an API key')
    expect(accountName(OWN)).toBe('its own sign-in')
    expect(accountName({ ...OWN, ownName: 'personal' })).toBe('personal')
    expect(accountName(WORK)).toBe('work')
  })

  it('says each window’s share used, rounded, and who runs as it', () => {
    expect(windowsSaid(OWN)).toBe('42% of 5h · 10% of 7d')
    expect(windowsSaid(WORK)).toBe('')
    expect(whoseSaid(OWN)).toBe('new agents · 2 agents now')
    expect(whoseSaid(WORK)).toBe('new agents in shop')
  })

  it('groups each harness’s accounts, and says why one cannot have more', () => {
    const groups = harnessesOf(ANSWER)
    expect(groups.map((one) => [one.harness, one.head, one.accounts.length, one.why])).toEqual([
      ['claude-code', 'Claude Code', 2, null],
      ['pi', 'pi', 1, 'keeps one account'],
    ])
    expect(emptySaid(ANSWER)).toBeNull()
    expect(emptySaid({ ...ANSWER, accounts: null, said: 'ipax could not be asked: down' })).toBe(
      'ipax could not be asked: down',
    )
    expect(emptySaid({ ...ANSWER, accounts: [] })).toBe('No harness there has an account to show.')
  })
})

describe('the presses, as the window’s Accounts page offers them', () => {
  const words = (one: AccountAway, many: boolean) => pressesOf(one, many).map((press) => press.word)

  it('offers signing in again and out, naming the own sign-in, for one already on new agents', () => {
    expect(words(OWN, true)).toEqual(['Sign in again', 'Sign out', 'Name it'])
  })

  it('offers signing in, new agents and a twice-asked Remove for an added one', () => {
    expect(words(WORK, true)).toEqual(['Sign in', 'Use for new agents', 'Remove'])
    const remove = pressesOf(WORK, true).find((one) => one.do === 'remove')
    expect(remove).toMatchObject({ danger: true, again: 'Press again to remove' })
  })

  it('offers a key, not a sign-in, for an API-key account', () => {
    expect(words(KEYED, true)).toEqual(['Change its key', 'Use for new agents', 'Remove'])
    expect(words({ ...KEYED, signedIn: false }, true)[0]).toBe('Set its key')
  })

  it('offers nothing to choose between where a harness keeps one account', () => {
    expect(words({ ...PI, forNewAgents: false }, false)).toEqual(['Sign in again'])
  })

  it('offers adding one only where the harness keeps accounts apart', () => {
    const [claude, pi] = harnessesOf(ANSWER)
    expect(addsOf(claude as never).map((one) => [one.word, one.kind])).toEqual([
      ['Add an account', 'subscription'],
      ['Add an API-key account', 'api-key'],
    ])
    expect(addsOf(pi as never)).toEqual([])
  })

  it('asks for a key in a field that hides it, and a name with what it is called now', () => {
    const [claude] = harnessesOf(ANSWER)
    const key = pressesOf(KEYED, true)[0] as never
    expect(askedOf(key, KEYED, claude as never)).toEqual({
      label: "ci's API key",
      value: '',
      secret: true,
    })
    const name = pressesOf({ ...OWN, ownName: 'personal' }, true).find((one) => one.do === 'name')
    expect(askedOf(name as never, { ...OWN, ownName: 'personal' }, claude as never)).toEqual({
      label: "Name Claude Code's own sign-in",
      value: 'personal',
      secret: false,
    })
    const add = addsOf(claude as never)[1] as never
    expect(askedOf(add, OWN, claude as never).label).toBe(
      'Add a Claude Code account, paid with an API key',
    )
  })
})

describe('what a press sends', () => {
  const presses = (one: AccountAway) => pressesOf(one, true)
  const by = (one: AccountAway, verb: string) =>
    presses(one).find((press) => press.do === verb) as never

  it('names no machine on this machine’s tab and the machine on another’s, and the door parses each', () => {
    const sent = [
      lookBody(null),
      lookBody('ipax'),
      pressBody(by(WORK, 'use'), WORK, null),
      pressBody(by(OWN, 'sign-out'), OWN, 'ipax'),
      pressBody(by(WORK, 'remove'), WORK, 'ipax'),
      pressBody(by(OWN, 'name'), OWN, null, '  Personal '),
      pressBody(by(OWN, 'name'), OWN, null, ''),
      pressBody(by(KEYED, 'key'), KEYED, 'ipax', ' sk-test '),
      pressBody(addsOf(harnessesOf(ANSWER)[0] as never)[0] as never, OWN, 'ipax', 'Team'),
    ]
    expect(sent).toEqual([
      { do: 'look' },
      { machine: 'ipax', do: 'look' },
      { do: 'use', harness: 'claude-code', account: 'work' },
      { machine: 'ipax', do: 'sign-out', harness: 'claude-code', account: null },
      { machine: 'ipax', do: 'remove', account: 'work' },
      { do: 'name', harness: 'claude-code', name: 'Personal' },
      { do: 'name', harness: 'claude-code', name: '' },
      { machine: 'ipax', do: 'key', account: 'ci', key: 'sk-test' },
      { machine: 'ipax', do: 'add', harness: 'claude-code', name: 'Team', kind: 'subscription' },
    ])
    for (const body of sent)
      expect(AccountsCall.safeParse(body).success, JSON.stringify(body)).toBe(true)
  })

  it('sends nothing for a press that needs words it was not given, or that is the sheet’s', () => {
    expect(pressBody(by(OWN, 'sign-in'), OWN, null)).toBeNull()
    expect(pressBody(by(KEYED, 'key'), KEYED, null)).toBeNull()
    const add = addsOf(harnessesOf(ANSWER)[0] as never)[0] as never
    expect(pressBody(add, OWN, null, '   ')).toBeNull()
  })

  it('drives a sign-in on the machine whose account it is, by a body the door parses', () => {
    expect(signInWith('claude-code', 'work', null)).toEqual({
      harness: 'claude-code',
      account: 'work',
    })
    expect(signInWith('claude-code', null, 'ipax')).toEqual({
      machine: 'ipax',
      harness: 'claude-code',
      account: null,
    })
    for (const call of ['look', 'start', 'cancel']) {
      const body = { ...signInWith('claude-code', null, 'ipax'), do: call }
      expect(AccountSignInCall.safeParse(body).success, call).toBe(true)
    }
    expect(signInHeading('work', null)).toBe('Sign work in')
    expect(signInHeading('its own sign-in', 'ipax')).toBe('Sign its own sign-in in on ipax')
  })

  it('says the sign-in’s words: starting, the harness’s own while it runs, then how it ended', () => {
    expect(accountSignInSaid(null)).toBe('Starting its sign-in…')
    const running = { state: 'running', who: 'work', how: 'Claude Code prints a link.', said: null }
    expect(accountSignInSaid(running)).toBe('Signing in work. Claude Code prints a link.')
    expect(accountSignInSaid({ ...running, state: 'ended', said: 'Signed in as work.' })).toBe(
      'Signed in as work.',
    )
    expect(accountSignInSaid({ ...running, state: 'idle' })).toBe('No sign-in is running for it.')
  })

  it('asks the two doors the server serves', () => {
    const paths = OWNED.map((route) => route.path)
    expect(paths).toContain(ACCOUNTS_PATH)
    expect(paths).toContain(ACCOUNT_SIGN_IN_PATH)
  })
})

describe('the page, drawn and pressed', () => {
  const was = Reflect.get(globalThis, 'document')
  beforeEach(() => {
    Object.defineProperty(globalThis, 'document', {
      value: new StillDocument(),
      configurable: true,
      writable: true,
    })
  })
  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      value: was,
      configurable: true,
      writable: true,
    })
  })

  /** Every promise the page left running, settled. */
  const settle = async () => {
    for (let n = 0; n < 20; n += 1) await Promise.resolve()
  }

  /** ipax's own accounts, as it answers through this machine. */
  const THERE: AccountsAnswer = { ...ANSWER, machine: 'ipax', accounts: [OWN, WORK] }

  /** A page over a machine that answers every look and press, and what it was asked. */
  async function drawn(answer: (body: Record<string, unknown>) => unknown = () => null) {
    const asked: [string, Record<string, unknown>][] = []
    const ctx = {
      ask: async (_method: string, path: string, body: Record<string, unknown>) => {
        asked.push([path, body])
        const own = answer(body)
        if (own !== null) return { status: 200, body: own }
        if (path === ACCOUNT_SIGN_IN_PATH) {
          return {
            status: 200,
            body: {
              state: 'running',
              who: 'team',
              how: 'Prints a link.',
              rows: [],
              link: null,
              said: null,
              about: null,
            },
          }
        }
        return { status: 200, body: body.machine === 'ipax' ? THERE : ANSWER }
      },
      session: () => ({ device: 'dev_7f3a9c21', label: 'iPhone' }),
      sentence: () => '',
    }
    const screen = accountsScreen(ctx)
    await settle()
    const node = screen.node as StillElement
    const button = (word: string, within: StillElement = node) => {
      const found = within.querySelectorAll('button').find((one) => one.textContent === word)
      if (found === undefined) throw new Error(`no button “${word}”`)
      return found
    }
    return { node, asked, button, screen }
  }

  it('asks this machine first, draws a tab per machine and every harness’s accounts', async () => {
    const { node, asked } = await drawn()
    expect(asked).toEqual([[ACCOUNTS_PATH, { do: 'look' }]])
    const tabs = node.querySelectorAll('.ac-tab')
    expect(tabs.map((one) => [one.textContent, one.getAttribute('aria-pressed')])).toEqual([
      ['laptop · here', 'true'],
      ['ipax', 'false'],
    ])
    expect(node.querySelectorAll('.ac-name').map((one) => one.textContent)).toEqual([
      'its own sign-in',
      'work',
      'its own sign-in',
    ])
    expect(node.querySelectorAll('.ac-windows')[0]?.textContent).toBe('42% of 5h · 10% of 7d')
    expect(
      node
        .querySelectorAll('.ac-why')
        .filter((one) => !one.hidden)
        .map((one) => one.textContent),
    ).toEqual(['pi keeps one account.'])
    // Said where somebody chooses which sign-in agents run as, as the window's page does.
    const keys = node.querySelector('.ac-keys') as StillElement
    expect(keys.hidden).toBe(false)
    expect(keys.textContent).toBe('An agent runs as you, whichever sign-in it is on.')
  })

  it('carries every press on another machine’s tab out there, naming it, and asks twice before removing', async () => {
    const { node, asked, button } = await drawn()
    ;(node.querySelectorAll('.ac-tab')[1] as StillElement).click()
    await settle()
    expect(asked.at(-1)).toEqual([ACCOUNTS_PATH, { machine: 'ipax', do: 'look' }])
    expect(node.querySelectorAll('.ac-tab')[1]?.getAttribute('aria-pressed')).toBe('true')
    button('Use for new agents').click()
    await settle()
    expect(asked.at(-1)).toEqual([
      ACCOUNTS_PATH,
      { machine: 'ipax', do: 'use', harness: 'claude-code', account: 'work' },
    ])
    const before = asked.length
    button('Remove').click()
    await settle()
    expect(asked).toHaveLength(before)
    button('Press again to remove').click()
    await settle()
    expect(asked.at(-1)).toEqual([
      ACCOUNTS_PATH,
      { machine: 'ipax', do: 'remove', account: 'work' },
    ])
  })

  it('asks a name for a new account, adds it there and goes straight into its sign-in there', async () => {
    const { node, asked, button } = await drawn()
    ;(node.querySelectorAll('.ac-tab')[1] as StillElement).click()
    await settle()
    button('Add an account').click()
    const form = node.querySelector('.ac-ask') as StillElement
    expect(form.parentNode?.hidden).toBe(false)
    const field = form.querySelector('input') as StillElement
    expect(field.getAttribute('type')).toBe('text')
    field.value = ' Team '
    form.dispatchEvent(new StillEvent('submit'))
    await settle()
    expect(asked.slice(-2)).toEqual([
      [
        ACCOUNTS_PATH,
        { machine: 'ipax', do: 'add', harness: 'claude-code', name: 'Team', kind: 'subscription' },
      ],
      [
        ACCOUNT_SIGN_IN_PATH,
        { machine: 'ipax', harness: 'claude-code', account: 'team', do: 'start' },
      ],
    ])
  })

  it('asks a key in a field that hides it, and signs in on this machine naming none', async () => {
    const { node, asked, button } = await drawn((body) =>
      body.do === 'look' && body.machine === undefined
        ? { ...ANSWER, accounts: [OWN, KEYED] }
        : null,
    )
    button('Change its key').click()
    const field = node.querySelector('.ac-ask input') as StillElement
    expect(field.getAttribute('type')).toBe('password')
    button('Sign in again').click()
    await settle()
    expect(asked.at(-1)).toEqual([
      ACCOUNT_SIGN_IN_PATH,
      { harness: 'claude-code', account: null, do: 'start' },
    ])
  })

  it('says why a machine could not be asked, in place of its accounts', async () => {
    const { node } = await drawn((body) =>
      body.machine === 'ipax'
        ? { ...THERE, accounts: null, said: 'ipax could not be asked: timed out', trouble: true }
        : null,
    )
    ;(node.querySelectorAll('.ac-tab')[1] as StillElement).click()
    await settle()
    expect(node.textContent).toContain('ipax could not be asked: timed out')
    expect(node.querySelectorAll('.ac-name')).toEqual([])
  })
})
