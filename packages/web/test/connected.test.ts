import { CONNECT_STATE_MS, type ConnectPage } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PAGE_CSP } from '../src/connect-page.ts'
import {
  ConnectAnswerSchema,
  ConnectStates,
  type ConnectWant,
  defaultName,
  STATES_HELD,
  type WebConnecting,
} from '../src/connected.ts'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { type Answer, ask, closeAll, pair, type Running, start } from './harness.ts'

// The guided pages that connect a source, over a real listener (REMOTE-TADE
// §6.4): the page and its presses answer on this machine's own door with no
// session and every cross-site layer that can apply, a press mints a one-time
// word for the host GitHub will send the browser back to, and a callback is
// answered for that word alone — once, for that host, within ten minutes. The
// guard's half is `guard.test.ts`'s cross-product; what the window does with a
// code is `packages/app/test/wire/web-connect.test.ts`.

afterEach(closeAll)

const PAGE: ConnectPage = {
  source: 'github',
  title: 'GitHub',
  steps: [
    {
      id: 'make',
      title: 'Make a GitHub App',
      done: false,
      said: 'one App <in> your account',
      press: { act: 'make', label: 'Make it on GitHub' },
    },
    {
      id: 'install',
      title: 'Install it on your repositories',
      done: false,
      said: 'once it is made',
    },
    { id: 'deliveries', title: 'Deliveries arrive', done: false, said: 'no public name' },
  ],
}

/** A window's half that records what it was asked and makes what a test says. */
function connecting(over: { made?: WebConnecting['made']; slug?: string | null } = {}) {
  const asked = {
    wants: [] as ConnectWant[],
    codes: [] as string[],
    installed: 0,
  }
  const half: WebConnecting = {
    page: async () => ({
      page: PAGE,
      asks: [{ what: 'Issues: read', why: 'to read an issue somebody labelled' }],
      events: ['issues'],
    }),
    form: (_source, want) => {
      asked.wants.push(want)
      return {
        url: `https://github.com/settings/apps/new?state=${want.state}`,
        fields: { manifest: '{}' },
      }
    },
    installUrl: (_source, state) =>
      over.slug === null
        ? null
        : `https://github.com/apps/${over.slug ?? 'tade-vps'}/installations/new?state=${state}`,
    made:
      over.made ??
      (async (_source, code) => {
        asked.codes.push(code)
        return { name: 'tade-vps <b>' }
      }),
    installed: () => {
      asked.installed++
    },
  }
  return { half, asked }
}

/** This machine's own name for the listener: the door the page answers on. */
const here = (one: Running) => `localhost:${one.host.split(':')[1]}`

function press(
  one: Running,
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return ask(one, path, {
    method: 'POST',
    headers: {
      host: here(one),
      origin: `http://${here(one)}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const back = (one: Running, path: string, host = here(one)) =>
  ask(one, path, { headers: { host, 'sec-fetch-site': 'cross-site' } })

const stateOf = (answer: Answer): string =>
  new URL(String(JSON.parse(answer.text).url)).searchParams.get('state') ?? ''

describe('the guided page', () => {
  it('answers this machine with every step and what making the App asks for, under its own policy', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    const page = await ask(one, '/connect', {
      headers: { host: here(one), 'sec-fetch-site': 'none' },
    })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['content-security-policy']).toBe(PAGE_CSP)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.text).toContain('Make a GitHub App')
    expect(page.text).toContain('Issues: read')
    expect(page.text).toContain('data-press="/connect/github/make"')
    // A step's words are somebody else's until escaped.
    expect(page.text).toContain('one App &lt;in&gt; your account')
    expect(page.text).not.toContain('<in>')
  })

  it('is the 404 of a path nobody built where the window wired no half', async () => {
    const one = await start()
    const page = await ask(one, '/connect', { headers: { host: here(one) } })
    expect(page.status).toBe(404)
  })

  it('asks no session, and needs none to be the person: a paired phone gets nothing more', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    const phone = await pair(one)
    const page = await ask(one, '/connect', { headers: { host: here(one), cookie: phone.cookie } })
    expect(page.status).toBe(200)
  })
})

describe('a press', () => {
  it('mints a word for the door it came in at where there is no public name, and makes no webhook', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const made = await press(one, '/connect/github/make', { name: 'Tade studio' })
    expect(made.status).toBe(200)
    const want = asked.wants[0]
    expect(want).toMatchObject({
      home: `http://${here(one)}`,
      hook: null,
      made: `http://${here(one)}/connect/github/made`,
      installed: `http://${here(one)}/connect/github/installed`,
      name: 'Tade studio',
    })
    expect(want?.state.length).toBeGreaterThanOrEqual(32)
    expect(JSON.parse(made.text).fields).toEqual({ manifest: '{}' })
  })

  it('names the public name for everything GitHub is told, where there is one', async () => {
    const { half, asked } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    await press(one, '/connect/github/make', { organisation: 'acme' })
    expect(asked.wants[0]).toMatchObject({
      home: 'https://tade.example.com',
      hook: 'https://tade.example.com/hooks/github',
      made: 'https://tade.example.com/connect/github/made',
      organisation: 'acme',
      name: 'Tade tade',
    })
  })

  it('is refused from another page: no Origin, a form, a cross-site fetch, another port', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const refused = [
      await press(one, '/connect/github/make', {}, { origin: '' }),
      await press(one, '/connect/github/make', {}, { 'content-type': 'text/plain' }),
      await press(one, '/connect/github/make', {}, { 'sec-fetch-site': 'cross-site' }),
      await press(one, '/connect/github/make', {}, { origin: 'http://localhost:1' }),
      await press(one, '/connect/github/make', {}, { origin: 'https://evil.example' }),
    ]
    for (const answer of refused) expect(answer.status, answer.text).toBe(403)
    expect(asked.wants).toEqual([])
  })

  it('takes nothing it was not built to: a path, a field it does not know, a name that is markup', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    for (const body of [{ path: '/etc' }, { name: '<script>' }, { organisation: '../x' }, []]) {
      expect((await press(one, '/connect/github/make', body)).status).toBe(400)
    }
  })

  it('says there is nothing to install before an App is kept', async () => {
    const { half } = connecting({ slug: null })
    const one = await start({}, { connecting: half })
    const install = await press(one, '/connect/github/install')
    expect(install.status).toBe(404)
    expect(JSON.parse(install.text).said).toContain('no App kept here')
  })
})

describe('where GitHub sends the browser back', () => {
  it('keeps what was made for the word a press minted, once, and offers the install next', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const state = stateOf(await press(one, '/connect/github/make'))
    const done = await back(one, `/connect/github/made?code=c0de&state=${state}`)
    expect(done.status).toBe(200)
    expect(asked.codes).toEqual(['c0de'])
    expect(done.text).toContain('tade-vps &lt;b&gt;')
    expect(done.text).toMatch(/installations\/new\?state=[\w-]{32}/)
    expect(done.text).not.toContain(state)
    const again = await back(one, `/connect/github/made?code=c0de&state=${state}`)
    expect(again.status).toBe(404)
    expect(asked.codes).toEqual(['c0de'])
  })

  it('answers a stranger nothing: no word, a word never minted, one for the other step', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const install = stateOf(await press(one, '/connect/github/install'))
    for (const path of [
      '/connect/github/made?code=c',
      '/connect/github/made?code=c&state=guessed',
      `/connect/github/made?code=c&state=${install}`,
    ]) {
      const answer = await back(one, path)
      expect(answer.status, path).toBe(404)
      expect(answer.text).toContain('nothing to finish here')
    }
    expect(asked.codes).toEqual([])
  })

  it('answers a word only at the host it was minted for', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const state = stateOf(await press(one, '/connect/github/make'))
    const elsewhere = await back(one, `/connect/github/made?code=c&state=${state}`, one.host)
    expect(elsewhere.status).toBe(404)
    expect(asked.codes).toEqual([])
  })

  it('answers no word older than ten minutes', async () => {
    let at = 1_800_000_000_000
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half, now: () => at })
    const state = stateOf(await press(one, '/connect/github/make'))
    at += CONNECT_STATE_MS
    expect((await back(one, `/connect/github/made?code=c&state=${state}`)).status).toBe(404)
    expect(asked.codes).toEqual([])
  })

  it('says what was not kept, in the window’s own words', async () => {
    const { half } = connecting({
      made: async () => ({ problem: 'GitHub does not know that code' }),
    })
    const one = await start({}, { connecting: half })
    const state = stateOf(await press(one, '/connect/github/make'))
    const failed = await back(one, `/connect/github/made?code=c&state=${state}`)
    expect(failed.status).toBe(502)
    expect(failed.text).toContain('GitHub does not know that code')
  })

  it('tells the window an install came back, and says so without saying anything kept', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const state = stateOf(await press(one, '/connect/github/install'))
    const done = await back(one, `/connect/github/installed?installation_id=7&state=${state}`)
    expect(done.status).toBe(200)
    expect(done.text).toContain('Installed')
    expect(asked.installed).toBe(1)
  })
})

describe('an owner asking from another machine', () => {
  async function asOwner(one: Running, body: unknown) {
    const port = Number(one.host.split(':')[1])
    const made = await mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
    return ask(one, '/api/connect', {
      method: 'POST',
      headers: {
        host: made.host,
        origin: `http://${made.host}`,
        cookie: `tade_away=${made.cookie}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: made.csrf,
      },
      body: JSON.stringify(body),
    })
  }

  it('reads the page as it stands, in the shape another machine reads', async () => {
    const { half } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    const answer = await asOwner(one, { source: 'github' })
    expect(answer.status).toBe(200)
    const read = ConnectAnswerSchema.parse(JSON.parse(answer.text))
    expect(read.page.steps.map((step) => step.id)).toEqual(['make', 'install', 'deliveries'])
    expect(read.form).toBeNull()
  })

  it('presses for a browser elsewhere only where GitHub can send it back here, to the public name', async () => {
    const { half, asked } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    const answer = ConnectAnswerSchema.parse(
      JSON.parse((await asOwner(one, { source: 'github', press: 'make' })).text),
    )
    expect(answer.form?.url).toContain('github.com/settings/apps/new')
    expect(asked.wants[0]?.made).toBe('https://tade.example.com/connect/github/made')
    // Minted for the public name, so this door cannot answer it.
    const state = asked.wants[0]?.state ?? ''
    expect((await back(one, `/connect/github/made?code=c&state=${state}`)).status).toBe(404)
  })

  it('says why it cannot where this machine has no public name', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const answer = ConnectAnswerSchema.parse(
      JSON.parse((await asOwner(one, { source: 'github', press: 'make' })).text),
    )
    expect(answer.form).toBeNull()
    expect(answer.cannot).toContain('no public name')
    expect(asked.wants).toEqual([])
  })

  it('answers no device that is not an owner', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    const phone = await pair(one)
    const answer = await ask(one, '/api/connect', {
      method: 'POST',
      headers: {
        origin: one.origin,
        cookie: phone.cookie,
        'content-type': 'application/json',
        [CSRF_HEADER]: phone.csrf,
      },
      body: JSON.stringify({ source: 'github' }),
    })
    // Refused as every owner route refuses a phone: it was not granted this.
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.text).error).toBe('out_of_scope')
  })
})

describe('the one-time words', () => {
  it('burns a word at its first use, whatever came of it', () => {
    const states = new ConnectStates()
    const what = { source: 'github' as const, press: 'make' as const, host: 'tade.example.com' }
    const one = states.mint(what, 0)
    expect(states.take(one, { ...what, press: 'install' }, 1)).toBe(false)
    expect(states.take(one, what, 1)).toBe(false)
    const two = states.mint(what, 0)
    expect(states.take(two, { ...what, host: 'TADE.example.com' }, 1)).toBe(true)
  })

  it('keeps no more than it was built to, the oldest going first', () => {
    const states = new ConnectStates()
    const what = { source: 'github' as const, press: 'make' as const, host: 'h' }
    const first = states.mint(what, 0)
    for (let n = 0; n < STATES_HELD; n++) states.mint(what, 0)
    expect(states.take(first, what, 1)).toBe(false)
  })

  it('suggests a name GitHub will take: short, and the machine’s', () => {
    expect(defaultName(null)).toBe('Tade')
    expect(defaultName('vps.example.com')).toBe('Tade vps')
    expect(defaultName(`${'x'.repeat(60)}.example.com`).length).toBeLessThanOrEqual(34)
  })
})
