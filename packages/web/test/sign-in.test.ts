import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement, StillEvent } from '../scripts/still-dom.ts'
import { isLogin, linkOf, SIGN_IN_PATH, signInSaid, signInSheet } from '../src/assets/sign-in.js'
import { allowDevice, grantDevice } from '../src/devices.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import { type SignInStanding, signInLink, type WebSigningIn } from '../src/signing-in.ts'
import { SCOPES } from '../src/surface.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// `/login` carried out from the person's own phone (`signing-in.ts`): the
// orchestrator's sign-in run on the machine and driven from the page — theirs
// and an owner's, never an ordinary phone's however much it was granted, one
// of five things asked and nothing else, and the page's sheet that asks them.

afterEach(closeAll)

const RUNNING: SignInStanding = {
  state: 'running',
  who: 'work',
  how: 'Claude Code prints a link.',
  rows: ['Paste code here if prompted >'],
  link: 'https://claude.ai/oauth/authorize?code=true',
  said: null,
}

/** A window half recording every call, each answered `RUNNING`. */
function half(): WebSigningIn & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const heard =
    (what: string) =>
    (...args: unknown[]) => {
      calls.push([what, ...args])
      return RUNNING
    }
  return {
    calls,
    look: heard('look'),
    start: heard('start'),
    type: heard('type'),
    key: heard('key'),
    cancel: heard('cancel'),
  }
}

function post(one: Running, device: Awaited<ReturnType<typeof pair>>, body: unknown) {
  return ask(one, SIGN_IN_PATH, {
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

async function theirs(one: Running) {
  const phone = await pair(one, { label: 'mine' })
  await allowDevice(one.home, phone.device, SCOPES, new Date())
  await grantDevice(one.home, phone.device, GRANTS, new Date())
  return phone
}

describe('the orchestrator’s sign-in, asked from the person’s own phone', () => {
  it('looks, starts, types, presses a key and cancels, each as the device’s', async () => {
    const signing = half()
    const one = await start({}, { owned: { orchestratorSignIn: signing } })
    const phone = await theirs(one)
    for (const body of [
      { do: 'look' },
      { do: 'start' },
      { do: 'type', text: 'abc#def' },
      { do: 'key', key: 'down' },
      { do: 'cancel' },
    ]) {
      const said = await post(one, phone, body)
      expect(said.status, said.text).toBe(200)
      expect(JSON.parse(said.text)).toEqual(RUNNING)
    }
    expect(signing.calls).toEqual([
      ['look', phone.device],
      ['start', phone.device],
      ['type', phone.device, 'abc#def'],
      ['key', phone.device, 'down'],
      ['cancel', phone.device],
    ])
  })

  it('takes nothing else, refuses an ordinary phone, and is the 404 of a path nobody wired', async () => {
    const signing = half()
    const one = await start({}, { owned: { orchestratorSignIn: signing } })
    const mine = await theirs(one)
    for (const body of [
      {},
      { do: 'run', command: 'sh' },
      { do: 'type', text: '' },
      { do: 'type', text: 'x'.repeat(4097) },
      { do: 'key', key: 'ctrl-c' },
      { do: 'start', account: 'other' },
    ]) {
      expect((await post(one, mine, body)).status, JSON.stringify(body)).toBe(400)
    }
    const phone = await pair(one)
    await grantDevice(one.home, phone.device, GRANTS, new Date())
    const refused = await post(one, phone, { do: 'start' })
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.text).error).toBe('out_of_scope')
    expect(signing.calls).toEqual([])
    const none = await start()
    expect((await post(none, await theirs(none), { do: 'look' })).status).toBe(404)
    expect(OWNED.find((route) => route.name === 'orchestrator sign-in')).toMatchObject({
      method: 'POST',
      path: SIGN_IN_PATH,
      here: true,
      theirs: true,
    })
  })
})

describe('the link a sign-in printed', () => {
  it('is the first https link, joined across the rows a terminal wrapped it over', () => {
    const link = `https://claude.ai/oauth/authorize?code=true&state=${'s'.repeat(30)}`
    const cols = 40
    const rows = ['Use the url below to sign in:', '']
    for (let at = 0; at < link.length; at += cols) rows.push(link.slice(at, at + cols))
    rows.push('', 'Paste code here if prompted >')
    expect(signInLink(rows.join('\n'), cols)).toBe(link)
  })

  it('leaves a sentence’s own punctuation off, and is null where there is none', () => {
    expect(signInLink('Open https://auth.openai.com/codex/device.', 200)).toBe(
      'https://auth.openai.com/codex/device',
    )
    expect(signInLink('(see https://example.com/x)', 200)).toBe('https://example.com/x')
    expect(signInLink('http://insecure.example.com and nothing else', 200)).toBeNull()
    expect(signInLink('', 200)).toBeNull()
  })
})

describe('the sheet `/login` opens on the page', () => {
  const was = Reflect.get(globalThis, 'document')
  let doc: StillDocument
  beforeEach(() => {
    doc = new StillDocument()
    Object.defineProperty(globalThis, 'document', {
      value: doc,
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

  it('knows `/login` as the window does: the first word, in any case', () => {
    expect(isLogin('/login')).toBe(true)
    expect(isLogin('  /LOGIN claude ')).toBe(true)
    expect(isLogin('/loginx')).toBe(false)
    expect(isLogin('please /login')).toBe(false)
    expect(isLogin(undefined)).toBe(false)
  })

  it('says who it signs in and how, then how it ended; and opens only an https link', () => {
    expect(signInSaid(null)).toBe('Starting the orchestrator’s sign-in…')
    expect(signInSaid(RUNNING)).toBe('The orchestrator runs as work. Claude Code prints a link.')
    expect(signInSaid({ ...RUNNING, state: 'ended', said: 'Signed in as work.' })).toBe(
      'Signed in as work.',
    )
    expect(linkOf(RUNNING)).toBe(RUNNING.link)
    expect(linkOf({ ...RUNNING, link: 'javascript:alert(1)' })).toBeNull()
    expect(linkOf(null)).toBeNull()
  })

  it('starts it, draws its link and screen, sends the code and the keys, and asks again while it runs', async () => {
    const asked: unknown[] = []
    let answer: SignInStanding = RUNNING
    const ctx = {
      ask: async (method: string, path: string, body: unknown) => {
        asked.push([method, path, body])
        return { status: 200, body: answer }
      },
      sentence: () => '',
      session: () => null,
    }
    const timers: (() => void)[] = []
    const sheet = signInSheet(
      ctx,
      (run) => timers.push(run),
      () => {},
    )
    await sheet.open()
    expect(asked).toEqual([['POST', SIGN_IN_PATH, { do: 'start' }]])
    const node = sheet.node as StillElement
    const link = node.querySelector('.signin-link') as StillElement
    expect(link.hidden).toBe(false)
    expect(link.getAttribute('href')).toBe(RUNNING.link)
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect((node.querySelector('.signin-screen') as StillElement).textContent).toBe(
      'Paste code here if prompted >',
    )
    const input = node.querySelector('input') as StillElement
    input.value = '  abc#def  '
    ;(node.querySelector('form') as StillElement).dispatchEvent(new StillEvent('submit'))
    ;(node.querySelector('[aria-label="Down"]') as StillElement).click()
    await Promise.resolve()
    expect(asked.slice(1)).toEqual([
      ['POST', SIGN_IN_PATH, { do: 'type', text: 'abc#def' }],
      ['POST', SIGN_IN_PATH, { do: 'key', key: 'down' }],
    ])
    expect(input.value).toBe('')
    // Asked again on its clock while it runs; once it ended, never again.
    answer = { ...RUNNING, state: 'ended', said: 'Signed in as work.' }
    timers.at(-1)?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(asked.at(-1)).toEqual(['POST', SIGN_IN_PATH, { do: 'look' }])
    const before = timers.length
    await Promise.resolve()
    expect(timers.length).toBe(before)
    expect((node.querySelector('form') as StillElement).hidden).toBe(true)
    expect((node.querySelector('.signin-how') as StillElement).textContent).toBe(
      'Signed in as work.',
    )
  })
})
