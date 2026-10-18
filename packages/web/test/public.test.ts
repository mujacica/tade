import { spawn } from 'node:child_process'
import { chmod, chown, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, createServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PUBLIC_IS_THE_INTERNET, PUBLIC_IS_THE_INTERNET_SHORT } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebConnecting } from '../src/connected.ts'
import { allowDevice, appendDevice, grantDevice } from '../src/devices.ts'
import { listenAll } from '../src/listeners.ts'
import { GRANTS } from '../src/reach.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { listenOn, SCOPES, surfaceOf } from '../src/surface.ts'
import { type Answer, ask, BASE, closeAll, pair, type Running, start } from './harness.ts'

// The public listener over a real Unix socket, the way Caddy reaches it: a
// PROXY header in front of each connection, then HTTP. What the guard decides
// about a `public` listener is `guard.test.ts`'s cross-product; this is that
// the socket is one, that the address a header carries is the one the pairing
// limit counts, and that the directory decides whether anything listens at all.

const NAME = 'tade.example.com'

afterEach(closeAll)

/** A directory like the one `publicDirCommand` makes: this user's, `2750`. */
async function dirFor(mode = 0o2750): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-pub-'))
  // This user's own group first: a folder in `/tmp` is `wheel`'s, and a setgid
  // bit on a group its owner is not in is dropped without a word.
  await chown(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0)
  await chmod(dir, mode)
  return dir
}

async function up(dir?: string): Promise<{ one: Running; socket: string }> {
  const socket = join(dir ?? (await dirFor()), 'away.sock')
  const one = await start({ publicName: NAME, trustedHosts: [NAME] }, { publicSocket: socket })
  return { one, socket }
}

/** Caddy's own version 2 header, for an IPv4 client. */
function header(from: string): Buffer {
  const head = Buffer.from('0d0a0d0a000d0a515549540a2111000c', 'hex')
  const body = Buffer.alloc(12)
  for (const [at, part] of from.split('.').entries()) body[at] = Number(part)
  return Buffer.concat([head, body])
}

/** One request through the socket, as Caddy makes it: the header first, or none. */
function viaCaddy(
  socket: string,
  from: string | null,
  path: string,
  over: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { host: NAME, ...over.headers }
  if (over.body !== undefined) headers['content-length'] = String(Buffer.byteLength(over.body))
  return new Promise((done, failed) => {
    const req = request(
      {
        path,
        method: over.method ?? 'GET',
        headers,
        createConnection: () => {
          const made = connect(socket)
          if (from !== null) made.write(header(from))
          return made
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, String(v ?? '')]),
            ),
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', failed)
    if (over.body !== undefined) req.write(over.body)
    req.end()
  })
}

/** A pairing claim from `from`, with a ticket of its own or a made-up one. */
function claim(one: Running, socket: string, from: string, ticket?: string): Promise<Answer> {
  return viaCaddy(socket, from, '/api/pair', {
    method: 'POST',
    headers: {
      origin: `https://${NAME}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ticket: ticket ?? one.tickets.mint(`https://${NAME}/pair`, Date.now()).value,
      label: 'iPhone',
    }),
  })
}

const warnings = (one: Running) =>
  one.told.flatMap((line) =>
    line.type === 'warning' ? [String((line.detail as { message: string }).message)] : [],
  )

describe('the socket Caddy connects to', () => {
  it('comes up beside the loopback listener, which stays as it was, group-writable and no more', async () => {
    const { one, socket } = await up()
    expect(one.server.public).toBe(socket)
    expect(one.server.bound.some((at) => at.startsWith('127.0.0.1:'))).toBe(true)
    expect((await stat(socket)).mode & 0o777).toBe(0o660)
    expect((await ask(one, '/')).status).toBe(200)
    expect((await viaCaddy(socket, '203.0.113.7', '/')).status).toBe(200)
  })

  it('pairs a phone under the address its header carries, never the socket’s', async () => {
    const { one, socket } = await up()
    const paired = await claim(one, socket, '203.0.113.7')
    expect(paired.status).toBe(201)
    expect(one.asked.map((asked) => asked.from)).toEqual(['203.0.113.7'])
    // https, through Caddy: the cookie that cannot be planted from a sibling name.
    expect(paired.headers['set-cookie']).toMatch(/^__Host-tade_away=.*Secure/)
  })

  it('counts the pairing limit per phone, so one phone cannot spend another’s', async () => {
    const { one, socket } = await up()
    for (let n = 0; n < 5; n++) {
      expect((await claim(one, socket, '203.0.113.7', 'x'.repeat(27))).status).not.toBe(429)
    }
    expect((await claim(one, socket, '203.0.113.7', 'x'.repeat(27))).status).toBe(429)
    expect((await claim(one, socket, '198.51.100.9')).status).toBe(201)
  })

  it('refuses this machine’s names, whatever the request says about itself', async () => {
    const { socket } = await up()
    for (const host of ['localhost', 'localhost:7654', '127.0.0.1', '[::1]']) {
      const answer = await viaCaddy(socket, '203.0.113.7', '/', { headers: { host } })
      expect(answer.status, host).toBe(403)
    }
    expect(
      (await viaCaddy(socket, '203.0.113.7', '/', { headers: { host: 'evil.example' } })).status,
    ).toBe(403)
  })

  it('never takes a session paired on this machine', async () => {
    const { one, socket } = await up()
    const mine = await pair(one)
    expect(mine.answer.status).toBe(201)
    expect((await ask(one, '/api/snapshot', { headers: { cookie: mine.cookie } })).status).toBe(200)
    // The same cookie through Caddy: under the public name it was not minted
    // for that host, and under this machine's own it never gets past the door.
    const public_ = await viaCaddy(socket, '203.0.113.7', '/api/snapshot', {
      headers: { cookie: mine.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(public_.status).toBe(401)
    const mimic = await viaCaddy(socket, '203.0.113.7', '/api/snapshot', {
      headers: { host: one.host, cookie: mine.cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(mimic.status).toBe(403)
  })

  it('answers a Caddy that sends no header, under one address, and says so once', async () => {
    const { one, socket } = await up()
    expect((await viaCaddy(socket, null, '/')).status).toBe(200)
    expect((await viaCaddy(socket, null, '/')).status).toBe(200)
    expect(
      warnings(one).filter((said) => said.includes('not sending the PROXY header')),
    ).toHaveLength(1)
    expect((await claim(one, socket, '203.0.113.7')).status).toBe(201)
  })

  it('closes a connection whose header is not one, and says so', async () => {
    const { one, socket } = await up()
    const heard = await new Promise<string>((done) => {
      const made = connect(socket)
      let got = ''
      made.on('data', (chunk) => (got += chunk))
      made.on('close', () => done(got))
      made.on('error', () => {})
      made.write('PROXY TCP4 nonsense\r\nGET / HTTP/1.1\r\nHost: tade.example.com\r\n\r\n')
    })
    expect(heard).toBe('')
    expect(warnings(one).some((said) => said.includes('closed a connection'))).toBe(true)
  })
})

describe('the person’s own phone at the public name', () => {
  // `Route.theirs`: what only the SSH key's session was answered, on this
  // machine's door alone, the person's own phone is answered here too — read
  // off the record at each request — and every other device still meets the
  // `404` of a path nobody built. `theirs.test.ts` has the guard's cross-product.
  async function upWith(heard: string[]): Promise<{ one: Running; socket: string }> {
    const socket = join(await dirFor(), 'away.sock')
    const one = await start(
      { publicName: NAME, trustedHosts: [NAME] },
      {
        publicSocket: socket,
        present: (device) => heard.push(device),
        owned: {
          taking: async (take, device) => {
            heard.push(`take ${take.name} ${device}`)
            return { took: false, said: 'not here' }
          },
        },
        connecting: connectingHalf(heard),
      },
    )
    return { one, socket }
  }
  async function phone(one: Running, socket: string, from: string) {
    const paired = await claim(one, socket, from)
    const body = JSON.parse(paired.text) as { device: string; csrf: string }
    const cookie = (paired.headers['set-cookie'] ?? '').split(';')[0] ?? ''
    return { device: body.device, csrf: body.csrf, cookie }
  }
  const post = (
    socket: string,
    made: { cookie: string; csrf: string },
    path: string,
    body: unknown,
  ) =>
    viaCaddy(socket, '203.0.113.7', path, {
      method: 'POST',
      headers: {
        origin: `https://${NAME}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: made.cookie,
        [CSRF_HEADER]: made.csrf,
      },
      body: JSON.stringify(body),
    })

  it('says the person is at a screen of theirs, where an ordinary phone is a 404', async () => {
    const heard: string[] = []
    const { one, socket } = await upWith(heard)
    const mine = await phone(one, socket, '203.0.113.7')
    const other = await phone(one, socket, '198.51.100.9')
    await allowDevice(one.home, mine.device, SCOPES, new Date())
    await grantDevice(one.home, mine.device, GRANTS, new Date())
    const said = await post(socket, mine, '/api/presence', { ago: 0 })
    expect(said.status, said.text).toBe(200)
    expect(heard).toEqual([mine.device])
    expect((await post(socket, other, '/api/presence', { ago: 0 })).status).toBe(404)
    // One box unticked, and it is an ordinary phone at the next request.
    await grantDevice(one.home, mine.device, GRANTS.slice(1), new Date())
    expect((await post(socket, mine, '/api/presence', { ago: 0 })).status).toBe(404)
    expect(heard).toEqual([mine.device])
  })

  it('hands this machine work to start, where an ordinary phone is a 404', async () => {
    const heard: string[] = []
    const { one, socket } = await upWith(heard)
    const mine = await phone(one, socket, '203.0.113.7')
    const other = await phone(one, socket, '198.51.100.9')
    await allowDevice(one.home, mine.device, SCOPES, new Date())
    await grantDevice(one.home, mine.device, GRANTS, new Date())
    const take = {
      from: 'phone',
      was: 'app/fix-it',
      project: 'app',
      name: 'fix-it',
      intent: 'fix it',
    }
    const took = await post(socket, mine, '/api/take', take)
    expect(took.status, took.text).toBe(200)
    expect(heard).toEqual([`take fix-it ${mine.device}`])
    expect((await post(socket, other, '/api/take', take)).status).toBe(404)
    expect(heard).toHaveLength(1)
  })

  it('draws the connect page for its session and takes its presses, with its token', async () => {
    const heard: string[] = []
    const { one, socket } = await upWith(heard)
    const mine = await phone(one, socket, '203.0.113.7')
    const other = await phone(one, socket, '198.51.100.9')
    await allowDevice(one.home, mine.device, SCOPES, new Date())
    await grantDevice(one.home, mine.device, GRANTS, new Date())
    // A typed address: a navigation, no `Origin`, Caddy's socket in the clear.
    const open = (cookie: string | null) =>
      viaCaddy(socket, '203.0.113.7', '/connect', {
        headers: { 'sec-fetch-site': 'none', ...(cookie === null ? {} : { cookie }) },
      })
    const page = await open(mine.cookie)
    expect(page.status, page.text).toBe(200)
    // Its presses carry the session's token, which is in the page and nowhere else.
    expect(page.text).toContain(`<meta name="tade-csrf" content="${mine.csrf}">`)
    expect(page.text).toContain('data-press="/connect/github/make"')
    for (const cookie of [other.cookie, null]) expect((await open(cookie)).status).toBe(404)

    const made = await post(socket, mine, '/connect/github/make', {})
    expect(made.status, made.text).toBe(200)
    expect(heard).toEqual([`make https://${NAME}/connect/github/made`])
    // With no token, it is any other mutation without one.
    const bare = await viaCaddy(socket, '203.0.113.7', '/connect/github/make', {
      method: 'POST',
      headers: {
        origin: `https://${NAME}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        cookie: mine.cookie,
      },
      body: '{}',
    })
    expect(bare.status).toBe(403)
    expect((await post(socket, other, '/connect/github/make', {})).status).toBe(404)
    expect(heard).toHaveLength(1)

    // Revoked, and it is nothing at the next request.
    await appendDevice(one.home, {
      kind: 'revoked',
      device: mine.device,
      at: new Date().toISOString(),
      why: 'revoked at the machine',
    })
    expect((await open(mine.cookie)).status).toBe(404)
    expect((await post(socket, mine, '/connect/github/make', {})).status).toBe(404)
    expect(heard).toHaveLength(1)
  })
})

/** A window's half of the connect pages that says which press made what. */
function connectingHalf(heard: string[]): WebConnecting {
  return {
    page: async (source) => ({
      page: {
        source,
        title: source,
        steps: [
          {
            id: 'make',
            title: 'Make it',
            done: false,
            said: 'one app',
            press: { act: 'make', label: 'Make it' },
          },
        ],
        writes: '',
      },
      asks: [],
      events: [],
    }),
    form: (_source, want) => {
      heard.push(`make ${want.made}`)
      return { url: 'https://github.com/settings/apps/new', fields: { manifest: '{}' } }
    },
    installUrl: () => null,
    made: async () => ({ problem: 'not in this test' }),
    installed: async () => ({ problem: 'not in this test' }),
    keep: async () => ({ problem: 'not in this test' }),
  }
}

describe('the public listener never comes up alone', () => {
  it('stays down, and says why, where nothing listens on this machine', async () => {
    // A window says whether anything listens by what is bound here; a public
    // socket beside nothing would be a panel saying *off* to the internet.
    const dir = await dirFor()
    const said: string[] = []
    const up = await listenAll(
      { ...BASE, enabled: false, publicName: NAME },
      async () => {},
      join(dir, 'away.sock'),
      (message) => said.push(message),
    )
    expect(up.servers).toEqual([])
    expect(up.public).toBeNull()
    expect(up.trouble).toContain('does not come up alone')
    expect(said).toEqual([up.trouble])
    await expect(stat(join(dir, 'away.sock'))).rejects.toThrow()
  })
})

describe('the directory decides whether anything listens for Caddy', () => {
  it('needs it to be there, and says how it is made', async () => {
    const { one } = await up(join(tmpdir(), 'tade-pub-not-there'))
    expect(one.server.public).toBeNull()
    expect(one.server.bound.length).toBeGreaterThan(0)
    expect(warnings(one).some((said) => said.includes('`tade host caddy`'))).toBe(true)
  })

  it('comes up when tried again once root has made it, and says a new reason once', async () => {
    // On a box being set up the directory is made after the away view is
    // turned on: found rehearsing a fresh Debian box, where it then stayed
    // down until a restart nobody was told about.
    const dir = await dirFor(0o755)
    const { one, socket } = await up(dir)
    expect(one.server.public).toBeNull()
    const before = warnings(one).length
    expect(await one.server.listenPublicAgain()).toBe(false)
    expect(warnings(one)).toHaveLength(before)
    await chmod(dir, 0o2750)
    expect(await one.server.listenPublicAgain()).toBe(true)
    expect(one.server.public).toBe(socket)
    expect(one.server.publicTrouble).toBeNull()
    expect(await one.server.listenPublicAgain()).toBe(true)
  })

  it('refuses one open to everybody, or with no setgid, and leaves it as it was', async () => {
    for (const mode of [0o2755, 0o750, 0o2700]) {
      const dir = await dirFor(mode)
      const { one } = await up(dir)
      expect(one.server.public, mode.toString(8)).toBeNull()
      expect((await stat(dir)).mode & 0o7777).toBe(mode)
      await rm(dir, { recursive: true })
    }
  })

  it('takes over a socket a Tade that did not close left behind', async () => {
    const dir = await dirFor()
    const socket = join(dir, 'away.sock')
    // A process that listens and is killed: nothing unlinks what it left.
    await new Promise<void>((done) => {
      const child = spawn(process.execPath, [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, 'SIGKILL'))`,
      ])
      child.on('exit', () => done())
    })
    expect((await stat(socket)).isSocket()).toBe(true)
    const { one } = await up(dir)
    expect(one.server.public).toBe(socket)
    expect((await viaCaddy(socket, '203.0.113.7', '/')).status).toBe(200)
  })

  it('never takes one something still answers on, and never removes what is not a socket', async () => {
    const dir = await dirFor()
    const socket = join(dir, 'away.sock')
    // Linux says the probe's reset to this side as `ECONNRESET`; a Tade's own
    // socket has a listener for it (`proxied.ts`), and so does this stand-in.
    const other: NetServer = createServer((made) => {
      made.on('error', () => {})
      made.end('mine')
    })
    await new Promise<void>((done) => other.listen(socket, done))
    try {
      const { one } = await up(dir)
      expect(one.server.public).toBeNull()
      expect(warnings(one).some((said) => said.includes('already listens'))).toBe(true)
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
    await writeFile(socket, 'somebody’s file')
    const { one } = await up(dir)
    expect(one.server.public).toBeNull()
    expect((await stat(socket)).isFile()).toBe(true)
  })

  it('takes the socket away on close, a connection still saying who it is for included', async () => {
    const { one, socket } = await up()
    const made = connect(socket)
    made.on('error', () => {})
    await new Promise<void>((done) => made.on('connect', () => done()))
    made.write('PRO')
    const started = Date.now()
    await one.server.close()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(one.server.public).toBeNull()
    await expect(stat(socket)).rejects.toThrow()
  })
})

describe('what a public name is turned on as', () => {
  it('is a second socket under enabled, and the first trusted name', () => {
    const web = {
      enabled: true,
      bind: 'loopback' as const,
      port: 7654,
      trusted_hosts: ['studio.yak-bebop.ts.net', 'tade.example.com'],
      public: 'Tade.Example.com',
      passkey_hours: 12,
      acting: false,
      orchestrator: false,
      push: false,
      push_details: false,
      drafts: false,
      settings: false,
      install: false,
      offline: false,
    }
    const on = surfaceOf(web)
    expect(on.publicName).toBe('tade.example.com')
    // First, so the code a phone scans carries the name that works off this wifi.
    expect(on.trustedHosts).toEqual(['tade.example.com', 'studio.yak-bebop.ts.net'])
    // The loopback listener stays as it was: the name adds a socket, not an address.
    expect(listenOn(on)).toEqual(['127.0.0.1', '::1'])
    expect(surfaceOf({ ...web, enabled: false }).publicName).toBeNull()
    expect(surfaceOf({ ...web, public: '' }).publicName).toBeNull()
  })

  it('is said by who it lets in before what still stands, and the way out', () => {
    // `separation.test.ts` holds that it never calls the internet private.
    expect(PUBLIC_IS_THE_INTERNET).toContain('on the internet')
    expect(PUBLIC_IS_THE_INTERNET).toContain('anybody can load it')
    expect(PUBLIC_IS_THE_INTERNET).toContain('still needs the code this machine shows')
    expect(PUBLIC_IS_THE_INTERNET).toContain('never this machine')
    expect(PUBLIC_IS_THE_INTERNET).toContain('Clearing the name')
    expect(PUBLIC_IS_THE_INTERNET_SHORT).toContain('anybody on the internet')
    expect(PUBLIC_IS_THE_INTERNET_SHORT.length).toBeLessThan(60)
  })
})
