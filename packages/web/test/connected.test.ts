import { createHash } from 'node:crypto'
import { chmod, chown, mkdtemp } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECT_STATE_MS, type ConnectPage } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PAGE_CSP } from '../src/connect-page.ts'
import {
  ConnectAnswerSchema,
  type ConnectReturn,
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
  writes: 'Nothing it may do writes anything.',
}

const SLACK: ConnectPage = {
  source: 'slack',
  title: 'Slack',
  steps: [
    {
      id: 'make',
      title: 'Make a Slack app',
      done: false,
      said: 'one app in your own workspace',
      press: { act: 'make', label: 'Make it on Slack' },
    },
    {
      id: 'keep',
      title: 'Give this machine its signing secret',
      done: false,
      said: 'from the app’s Basic Information',
      press: {
        act: 'keep',
        label: 'Keep them',
        fields: [
          { name: 'signing_secret', label: 'Signing Secret', secret: true },
          { name: 'client_id', label: 'Client ID', secret: false },
        ],
      },
    },
    { id: 'install', title: 'Install it in your workspace', done: false, said: 'once kept' },
  ],
  writes: 'It writes nothing unless you turn reply on.',
}

const LINEAR: ConnectPage = {
  source: 'linear',
  title: 'Linear',
  steps: [
    {
      id: 'make',
      title: 'Make a Linear app',
      done: false,
      said: 'one private app in your own workspace',
      press: { act: 'make', label: 'Make it on Linear' },
    },
    {
      id: 'keep',
      title: 'Give this machine its client id',
      done: false,
      said: 'from the app’s page on Linear',
      press: {
        act: 'keep',
        label: 'Keep it',
        fields: [{ name: 'client_id', label: 'Client ID', secret: false }],
      },
    },
    { id: 'install', title: 'Connect it to your workspace', done: false, said: 'once kept' },
  ],
  writes: 'Nothing it may do writes anything.',
}

/** A window's half that records what it was asked and makes what a test says. */
function connecting(
  over: {
    made?: WebConnecting['made']
    slug?: string | null
    installed?: WebConnecting['installed']
  } = {},
) {
  const asked = {
    wants: [] as ConnectWant[],
    codes: [] as string[],
    installed: 0,
    backs: [] as ConnectReturn[],
    kept: [] as Record<string, string | undefined>[],
    homes: [] as string[],
    challenges: [] as (string | null)[],
  }
  const half: WebConnecting = {
    page: async (source) =>
      ({
        github: {
          page: PAGE,
          asks: [{ what: 'Issues: read', why: 'to read an issue somebody labelled' }],
          events: ['issues'],
        },
        slack: {
          page: SLACK,
          asks: [{ what: 'channels:history', why: 'to read a channel you invite it to' }],
          events: ['app_mention'],
        },
        linear: {
          page: LINEAR,
          asks: [{ what: 'read', why: 'to read the team you name' }],
          events: [] as string[],
        },
      })[source],
    form: (source, want) => {
      asked.wants.push(want)
      if (source === 'slack') return { url: 'https://api.slack.com/apps?new_app=1' }
      if (source === 'linear') return { url: 'https://linear.app/settings/api/applications/new' }
      return {
        url: `https://github.com/settings/apps/new?state=${want.state}`,
        fields: { manifest: '{}' },
      }
    },
    installUrl: (source, state, home, challenge) => {
      asked.homes.push(home)
      asked.challenges.push(challenge)
      if (over.slug === null) return null
      return {
        github: `https://github.com/apps/${over.slug ?? 'tade-vps'}/installations/new?state=${state}`,
        slack: `https://slack.com/oauth/v2/authorize?state=${state}`,
        linear: `https://linear.app/oauth/authorize?state=${state}&code_challenge=${challenge}`,
      }[source]
    },
    made:
      over.made ??
      (async (_source, code) => {
        asked.codes.push(code)
        return { name: 'tade-vps <b>' }
      }),
    installed:
      over.installed ??
      (async (source, back) => {
        asked.installed++
        asked.backs.push(back)
        return { where: source === 'github' ? null : 'Acme <Inc>' }
      }),
    keep: async (_source, fields) => {
      asked.kept.push(fields)
      return { kept: Object.keys(fields).map((one) => one.replace('_', ' ')) }
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
    expect(JSON.parse(install.text).said).toContain('no app kept here')
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

describe('Slack, on the same pages', () => {
  const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
  const NAME = 'tade.example.com'

  /** A listener with a public name and the socket Caddy would reach it through. */
  async function withPublic(half: WebConnecting): Promise<{ one: Running; socket: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'tade-connect-'))
    // This user's own group first: a folder in `/tmp` is `wheel`'s, and a
    // setgid bit on a group its owner is not in is dropped without a word.
    await chown(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0)
    await chmod(dir, 0o2750)
    const socket = join(dir, 'away.sock')
    const one = await start(
      { publicName: NAME, trustedHosts: [NAME] },
      { connecting: half, publicSocket: socket },
    )
    return { one, socket }
  }

  /** Where Slack sends the browser back: the public name, through Caddy's socket. */
  function viaPublic(socket: string, path: string): Promise<Answer> {
    return new Promise((done, failed) => {
      const req = request(
        { path, headers: { host: NAME }, createConnection: () => connect(socket) },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              headers: {},
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      req.on('error', failed)
      req.end()
    })
  }

  it('draws its steps beside GitHub’s, its secrets as boxes that hide what is typed', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    const page = await ask(one, '/connect', { headers: { host: here(one) } })
    expect(page.text).toContain('Make a Slack app')
    expect(page.text).toContain('data-press="/connect/slack/keep"')
    expect(page.text).toContain('What it asks Slack for, and why')
    expect(page.text).toContain('channels:history')
    expect(page.text).toMatch(/<input name="signing_secret" type="password" autocomplete="off"/)
    expect(page.text).toMatch(/<input name="client_id" type="text"/)
    expect(page.text).toContain('It writes nothing unless you turn reply on.')
  })

  it('makes the app from Slack’s own page and mints no word, since nothing comes back from it', async () => {
    const { half, asked } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    const made = await press(one, '/connect/slack/make')
    expect(made.status).toBe(200)
    expect(JSON.parse(made.text)).toEqual({ url: 'https://api.slack.com/apps?new_app=1' })
    expect(asked.wants[0]).toMatchObject({
      home: 'https://tade.example.com',
      hook: 'https://tade.example.com/hooks/slack',
      state: '',
    })
  })

  it('keeps what was pasted, in its shape, and never answers it back', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const kept = await press(one, '/connect/slack/keep', {
      signing_secret: ` ${SECRET} `,
      client_id: '1234.5678',
      client_secret: '',
    })
    expect(kept.status, kept.text).toBe(200)
    // Trimmed, and an empty box left alone rather than refused or written.
    expect(asked.kept).toEqual([{ signing_secret: SECRET, client_id: '1234.5678' }])
    expect(JSON.parse(kept.text).said).toBe('kept: signing secret, client id')
    expect(kept.text).not.toContain(SECRET)
  })

  it('says which box was not what it should have held, and keeps nothing', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const wrong = await press(one, '/connect/slack/keep', { client_id: 'xoxb-not-an-id' })
    expect(wrong.status).toBe(400)
    expect(JSON.parse(wrong.text).said).toContain('the Client ID is two numbers')
    for (const body of [{}, { client_secret: '   ' }, { path: '/etc' }, { name: 'Tade' }]) {
      expect((await press(one, '/connect/slack/keep', body)).status).toBe(400)
    }
    expect(asked.kept).toEqual([])
  })

  it('keeps nothing a page elsewhere asked for: the keep press has every layer a press has', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const elsewhere: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'text/plain' },
    ]
    for (const headers of elsewhere) {
      const answer = await press(one, '/connect/slack/keep', { signing_secret: SECRET }, headers)
      expect(answer.status).toBe(403)
    }
    expect(asked.kept).toEqual([])
  })

  it('has no keep for GitHub, which hands its App over itself', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    expect((await press(one, '/connect/github/keep', { token: 'x' })).status).toBe(404)
  })

  it('installs only where Slack can send the browser back: a public name, never this door', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const refused = await press(one, '/connect/slack/install')
    expect(refused.status).toBe(404)
    expect(JSON.parse(refused.text).said).toContain('keep its token here')
    expect(asked.homes).toEqual([])
  })

  it('exchanges the code the word came back with, at the public name, once', async () => {
    const { half, asked } = connecting()
    const { one, socket } = await withPublic(half)
    const pressed = await press(one, '/connect/slack/install')
    expect(asked.homes).toEqual([`https://${NAME}`])
    const state = stateOf(pressed)
    const path = `/connect/slack/installed?code=c0de&state=${state}`
    // Minted for the public name: this machine's own door finds nothing, and
    // the word is burned by the try.
    expect((await back(one, path)).status).toBe(404)
    const again = stateOf(await press(one, '/connect/slack/install'))
    const done = await viaPublic(socket, `/connect/slack/installed?code=c0de&state=${again}`)
    expect(done.status, done.text).toBe(200)
    expect(asked.backs).toEqual([
      { code: 'c0de', error: null, home: `https://${NAME}`, verifier: null },
    ])
    // Slack installs with no proof key, so none was minted or sent.
    expect(asked.challenges).toEqual([null, null])
    expect(done.text).toContain('Installed in Acme &lt;Inc&gt;')
    const replay = await viaPublic(socket, `/connect/slack/installed?code=c0de&state=${again}`)
    expect(replay.status).toBe(404)
    expect(asked.installed).toBe(1)
  })

  it('says why nothing was kept where Slack said no', async () => {
    const { half, asked } = connecting({
      installed: async (_source, back) => ({ problem: `Slack did not install it (${back.error})` }),
    })
    const { one, socket } = await withPublic(half)
    const state = stateOf(await press(one, '/connect/slack/install'))
    const failed = await viaPublic(
      socket,
      `/connect/slack/installed?error=access_denied&state=${state}`,
    )
    expect(failed.status).toBe(502)
    expect(failed.text).toContain('Slack did not install it (access_denied)')
    expect(asked.installed).toBe(0)
  })

  it('reads for an owner elsewhere, and never takes what is pasted from one', async () => {
    const port = (one: Running) => Number(one.host.split(':')[1])
    const { half, asked } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    const made = await mintOwner(one.home, { port: port(one), label: 'mac', from: '' }, Date.now())
    const asOwner = (body: unknown) =>
      ask(one, '/api/connect', {
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
    const read = ConnectAnswerSchema.parse(JSON.parse((await asOwner({ source: 'slack' })).text))
    expect(read.page.steps.map((step) => step.id)).toEqual(['make', 'keep', 'install'])
    expect(read.page.writes).toBe('It writes nothing unless you turn reply on.')
    const pressed = await asOwner({ source: 'slack', press: 'keep', signing_secret: SECRET })
    expect(pressed.status).toBe(400)
    expect(asked.kept).toEqual([])
  })
})

describe('Linear, on the same pages', () => {
  const CLIENT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'

  it('draws its steps beside the others, asking for its client id and never a client secret', async () => {
    const { half } = connecting()
    const one = await start({}, { connecting: half })
    const page = await ask(one, '/connect', { headers: { host: here(one) } })
    expect(page.text).toContain('Make a Linear app')
    expect(page.text).toContain('data-press="/connect/linear/keep"')
    expect(page.text).toContain('data-press="/connect/linear/make"')
    expect(page.text).not.toContain('name="client_secret"')
  })

  it('makes the app from Linear’s own page and mints no word, since nothing comes back from it', async () => {
    const { half, asked } = connecting()
    const one = await start({ publicName: 'tade.example.com' }, { connecting: half })
    const made = await press(one, '/connect/linear/make')
    expect(JSON.parse(made.text)).toEqual({
      url: 'https://linear.app/settings/api/applications/new',
    })
    expect(asked.wants[0]).toMatchObject({
      hook: 'https://tade.example.com/hooks/linear',
      state: '',
    })
  })

  it('connects with a proof key: only the digest leaves, and the verifier comes back with the word, once', async () => {
    const { half, asked } = connecting()
    // No public name: Linear sends the browser back to this door, which it allows.
    const one = await start({}, { connecting: half })
    const pressed = await press(one, '/connect/linear/install')
    expect(pressed.status, pressed.text).toBe(200)
    const url = new URL(String(JSON.parse(pressed.text).url))
    const challenge = url.searchParams.get('code_challenge') ?? ''
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(asked.homes).toEqual([`http://${here(one)}`])
    const state = stateOf(pressed)
    const done = await back(one, `/connect/linear/installed?code=c0de&state=${state}`)
    expect(done.status, done.text).toBe(200)
    expect(done.text).toContain('Connected to Acme &lt;Inc&gt;')
    const [came] = asked.backs
    expect(came).toMatchObject({ code: 'c0de', error: null, home: `http://${here(one)}` })
    // The verifier is the one the challenge was made from, and it never left.
    const verifier = String(came?.verifier)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
    expect(pressed.text).not.toContain(verifier)
    expect(done.text).not.toContain(verifier)
    // Burned by its first use.
    expect((await back(one, `/connect/linear/installed?code=c0de&state=${state}`)).status).toBe(404)
    // Two presses, two verifiers.
    const again = await press(one, '/connect/linear/install')
    expect(new URL(String(JSON.parse(again.text).url)).searchParams.get('code_challenge')).not.toBe(
      challenge,
    )
  })

  it('keeps the client id and the signing secret in Linear’s shapes, and nothing else', async () => {
    const { half, asked } = connecting()
    const one = await start({}, { connecting: half })
    const kept = await press(one, '/connect/linear/keep', {
      client_id: CLIENT,
      signing_secret: 'lin_wh_abcdefghijklmnopqrstuvwxyz0123456789',
    })
    expect(kept.status, kept.text).toBe(200)
    expect(asked.kept).toEqual([
      { client_id: CLIENT, signing_secret: 'lin_wh_abcdefghijklmnopqrstuvwxyz0123456789' },
    ])
    expect(kept.text).not.toContain('lin_wh_')
    // A personal key pasted as the client id is said, naming the box.
    const wrong = await press(one, '/connect/linear/keep', {
      client_id: 'lin_api_0123456789abcdef',
    })
    expect(wrong.status).toBe(400)
    expect(JSON.parse(wrong.text).said).toContain('the Client ID is the letters and digits')
    // A client secret is never taken: Linear needs none, and the box is not Linear's.
    const secret = await press(one, '/connect/linear/keep', { client_secret: 'c'.repeat(32) })
    expect(secret.status).toBe(400)
    expect(JSON.parse(secret.text).said).toContain('only what the page asks for')
    expect(asked.kept).toHaveLength(1)
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
    expect(states.take(one, { ...what, press: 'install' }, 1)).toBeNull()
    expect(states.take(one, what, 1)).toBeNull()
    const two = states.mint(what, 0)
    expect(states.take(two, { ...what, host: 'TADE.example.com' }, 1)).toEqual({ verifier: null })
  })

  it('hands back the proof key’s verifier with its word, and only with it', () => {
    const states = new ConnectStates()
    const what = { source: 'linear' as const, press: 'install' as const, host: 'h' }
    const one = states.mint({ ...what, verifier: 'v-1' }, 0)
    expect(states.take(one, { ...what, source: 'github' }, 1)).toBeNull()
    const two = states.mint({ ...what, verifier: 'v-2' }, 0)
    expect(states.take(two, what, 1)).toEqual({ verifier: 'v-2' })
  })

  it('keeps no more than it was built to, the oldest going first', () => {
    const states = new ConnectStates()
    const what = { source: 'github' as const, press: 'make' as const, host: 'h' }
    const first = states.mint(what, 0)
    for (let n = 0; n < STATES_HELD; n++) states.mint(what, 0)
    expect(states.take(first, what, 1)).toBeNull()
  })

  it('suggests a name GitHub will take: short, and the machine’s', () => {
    expect(defaultName(null)).toBe('Tade')
    expect(defaultName('vps.example.com')).toBe('Tade vps')
    expect(defaultName(`${'x'.repeat(60)}.example.com`).length).toBeLessThanOrEqual(34)
  })
})
