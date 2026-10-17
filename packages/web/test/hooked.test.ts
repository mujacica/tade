import { createHmac } from 'node:crypto'
import { chmod, chown, mkdtemp } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookAddress, HookSource } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_TRIES, REFUSED_EVERY_MS, type WebHooks } from '../src/hooked.ts'
import { HOOK_BODY_MAX } from '../src/hooks.ts'
import { type Answer, ask, closeAll, type Running, start } from './harness.ts'

// The doorbell's door over a real Unix socket, the way Caddy reaches it
// (REMOTE-TADE §6.2): what is answered, what is written down, and that a
// delivery only ever asks the window which schedules it is for and then wakes
// them — after the line, and never for one that did not verify. Each
// source's signature is `hooks.test.ts`'s; the guard's layer is
// `guard.test.ts`'s cross-product.

const NAME = 'tade.example.com'
const SECRET = 'a webhook secret'

afterEach(closeAll)

/** What the window was asked, in order. */
interface Asked {
  matched: HookAddress[]
  woke: { ids: readonly string[]; lines: number; item?: string }[]
}

async function up(
  over: {
    secrets?: Partial<Record<HookSource, string>>
    match?: (address: HookAddress) => Promise<readonly string[]>
    now?: () => number
    hooks?: false
  } = {},
): Promise<{ one: Running; socket: string; asked: Asked }> {
  const dir = await mkdtemp(join(tmpdir(), 'tade-hook-'))
  // This user's own group first: a folder in `/tmp` is `wheel`'s, and a setgid
  // bit on a group its owner is not in is dropped without a word.
  await chown(dir, process.getuid?.() ?? 0, process.getgid?.() ?? 0)
  await chmod(dir, 0o2750)
  const socket = join(dir, 'away.sock')
  const asked: Asked = { matched: [], woke: [] }
  const secrets = over.secrets ?? { github: SECRET }
  const hooks: WebHooks = {
    secret: (source) => secrets[source] ?? null,
    match: async (address) => {
      asked.matched.push(address)
      return over.match ? over.match(address) : ['github-issues']
    },
    wake: (ids, item) =>
      asked.woke.push({ ids, lines: rungs(one).length, ...(item === undefined ? {} : { item }) }),
  }
  const one = await start(
    { publicName: NAME, trustedHosts: [NAME] },
    {
      publicSocket: socket,
      ...(over.hooks === false ? {} : { hooks }),
      ...(over.now === undefined ? {} : { now: over.now }),
    },
  )
  return { one, socket, asked }
}

/** One delivery through Caddy's socket. */
function deliver(
  socket: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((done, failed) => {
    const req = request(
      {
        path,
        method: 'POST',
        headers: {
          host: NAME,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
        createConnection: () => connect(socket),
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
    req.write(body)
    req.end()
  })
}

const ISSUE = JSON.stringify({
  action: 'labeled',
  repository: { html_url: 'https://github.com/acme/app' },
  issue: { body: 'please run this for me' },
})

function github(body: string, id = 'delivery-1', secret = SECRET): Record<string, string> {
  return {
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    'x-github-event': 'issues',
    'x-github-delivery': id,
  }
}

/** The `hook_rung` lines, as written. */
function rungs(one: Running): Record<string, unknown>[] {
  return one.told.filter((told) => told.type === 'hook_rung').map((told) => told.detail)
}

/** Until the window has been asked to wake something, or a second has gone. */
async function woken(asked: Asked): Promise<void> {
  for (let tries = 0; tries < 100 && asked.woke.length === 0; tries++) {
    await new Promise((done) => setTimeout(done, 10))
  }
}

describe('a delivery that verifies', () => {
  it('is answered at once, written down with what it woke, and wakes it after the line', async () => {
    const { one, socket, asked } = await up()
    const answer = await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    expect(answer.status).toBe(200)
    await woken(asked)
    expect(asked.matched).toEqual([
      { source: 'github', event: 'issues', where: 'github.com/acme/app' },
    ])
    const [line] = rungs(one)
    expect(line).toMatchObject({ source: 'github', verified: true, event: 'issues' })
    expect(line?.woke).toEqual(['github-issues'])
    expect(String(line?.delivery)).toMatch(/^[0-9a-f]{16}$/)
    // The line is there before the look is asked for: what the window reads as
    // a look the doorbell made is what came after it in the journal.
    expect(asked.woke).toEqual([{ ids: ['github-issues'], lines: 1 }])
    // Never the payload, and never the source's own id for it.
    expect(JSON.stringify(one.told)).not.toContain('please run this')
    expect(JSON.stringify(one.told)).not.toContain('delivery-1')
  })

  it('is a repeat the second time, answered and written down, and wakes nothing again', async () => {
    let now = Date.parse('2026-10-17T12:00:00Z')
    const { one, socket, asked } = await up({ now: () => now })
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    await woken(asked)
    const again = await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    expect(again.status).toBe(200)
    expect(asked.matched).toHaveLength(1)
    expect(asked.woke).toHaveLength(1)
    expect(rungs(one)[1]).toMatchObject({ verified: true, why: 'duplicate', woke: [] })
    // GitHub signs no moment, so a captured delivery verifies for ever: its
    // repeats are a line a minute, with the count, like a refusal's — and
    // still say they verified, so the poll is not made to fall back by them.
    for (let n = 0; n < 4; n++) await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    expect(rungs(one)).toHaveLength(2)
    now += REFUSED_EVERY_MS
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    expect(rungs(one)[2]).toMatchObject({ verified: true, why: 'duplicate', found: 5 })
    expect(asked.woke).toHaveLength(1)
  })

  it('wakes nothing where it is about nothing watched here, and says so', async () => {
    const { one, socket, asked } = await up({ match: async () => [] })
    expect((await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))).status).toBe(200)
    for (let tries = 0; tries < 100 && rungs(one).length === 0; tries++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(rungs(one)).toEqual([expect.objectContaining({ verified: true, woke: [] })])
    expect(asked.woke).toEqual([])
  })

  it('says it when the window could not say which watch it was for', async () => {
    const { one, socket, asked } = await up({
      match: () => Promise.reject(new Error('the extensions are not loaded')),
    })
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    for (let tries = 0; tries < 100 && rungs(one).length === 0; tries++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(rungs(one)[0]).toMatchObject({ verified: true, woke: [] })
    expect(String(rungs(one)[0]?.why)).toContain('in time')
    const warned = one.told.filter((told) => told.type === 'warning')
    expect(warned.map((told) => String(told.detail.message)).join(' ')).toContain(
      'the extensions are not loaded',
    )
    expect(asked.woke).toEqual([])
  })

  it('answers Slack’s URL check with its challenge, and rings nothing', async () => {
    const { one, socket, asked } = await up({ secrets: { slack: SECRET } })
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c-123' })
    const stamp = String(Math.floor(Date.now() / 1000))
    const answer = await deliver(socket, '/hooks/slack', body, {
      'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${body}`).digest('hex')}`,
      'x-slack-request-timestamp': stamp,
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.text)).toEqual({ challenge: 'c-123' })
    expect(asked.matched).toEqual([])
    expect(rungs(one)).toEqual([
      expect.objectContaining({ source: 'slack', event: 'url_verification', woke: [] }),
    ])
  })
})

describe('a Slack mention inside a thread', () => {
  const mention = (event: Record<string, unknown>) =>
    JSON.stringify({ type: 'event_callback', event_id: `Ev${String(event.ts)}`, event })
  const slack = (body: string) => {
    const stamp = String(Math.floor(Date.now() / 1000))
    return {
      'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${body}`).digest('hex')}`,
      'x-slack-request-timestamp': stamp,
    }
  }
  const inside = {
    type: 'app_mention',
    channel: 'C0ACME',
    ts: '1727445000.000200',
    thread_ts: '1727442000.000100',
    text: '<@U0TADE> and delete the backups',
  }

  it('hands the look what it named, on the line and with the wake, and never a word of it', async () => {
    const { one, socket, asked } = await up({
      secrets: { slack: SECRET },
      match: async () => ['slack-mentions'],
    })
    const body = mention(inside)
    expect((await deliver(socket, '/hooks/slack', body, slack(body))).status).toBe(200)
    await woken(asked)
    expect(asked.woke).toEqual([
      { ids: ['slack-mentions'], lines: 1, item: '1727445000.000200/1727442000.000100' },
    ])
    expect(rungs(one)[0]).toMatchObject({
      source: 'slack',
      verified: true,
      woke: ['slack-mentions'],
      item: '1727445000.000200/1727442000.000100',
    })
    expect(JSON.stringify(one.told)).not.toContain('delete the backups')
  })

  it('writes down nothing it named where it woke nothing to read it', async () => {
    const { one, socket } = await up({ secrets: { slack: SECRET }, match: async () => [] })
    const body = mention(inside)
    await deliver(socket, '/hooks/slack', body, slack(body))
    for (let tries = 0; tries < 100 && rungs(one).length === 0; tries++) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(rungs(one)[0]).toMatchObject({ verified: true, woke: [] })
    expect(rungs(one)[0]).not.toHaveProperty('item')
  })
})

describe('a delivery that does not verify', () => {
  it('is refused, asks the window nothing, and is a line a minute however many come', async () => {
    let now = Date.parse('2026-10-17T12:00:00Z')
    const { one, socket, asked } = await up({ now: () => now })
    const forged = github(ISSUE, 'guess', 'not the secret')
    expect((await deliver(socket, '/hooks/github', ISSUE, forged)).status).toBe(403)
    for (let n = 0; n < 4; n++) await deliver(socket, '/hooks/github', ISSUE, forged)
    expect(rungs(one)).toEqual([
      { source: 'github', delivery: '', verified: false, why: 'signature' },
    ])
    now += REFUSED_EVERY_MS
    await deliver(socket, '/hooks/github', ISSUE, {})
    expect(rungs(one)[1]).toEqual({
      source: 'github',
      delivery: '',
      verified: false,
      why: 'unsigned',
      found: 5,
    })
    expect(asked.matched).toEqual([])
    expect(asked.woke).toEqual([])
  })

  it('does not fill the ring, so the real one is not turned away as a repeat', async () => {
    const { socket, asked } = await up()
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE, 'delivery-1', 'guess'))
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE, 'delivery-1'))
    await woken(asked)
    expect(asked.woke).toHaveLength(1)
  })

  it('is answered 200 and left unread past the cap, and wakes nothing', async () => {
    const { one, socket, asked } = await up()
    const big = `{"pad":"${'x'.repeat(HOOK_BODY_MAX)}"}`
    const answer = await deliver(socket, '/hooks/github', big, github(big))
    expect(answer.status).toBe(200)
    expect(rungs(one)).toEqual([
      { source: 'github', delivery: '', verified: false, why: 'too big' },
    ])
    expect(asked.matched).toEqual([])
  })
})

describe('what is not a doorbell', () => {
  it('is a path nobody built for a source with no secret, or a window that wired none', async () => {
    const { socket } = await up({ secrets: { github: SECRET } })
    expect((await deliver(socket, '/hooks/slack', '{}')).status).toBe(404)
    expect((await deliver(socket, '/hooks/jira', '{}')).status).toBe(404)
    const unwired = await up({ hooks: false })
    expect((await deliver(unwired.socket, '/hooks/github', ISSUE, github(ISSUE))).status).toBe(404)
  })

  it('is a path nobody built on this machine’s own listener', async () => {
    const { one } = await up()
    const answer = await ask(one, '/hooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...github(ISSUE) },
      body: ISSUE,
    })
    expect(answer.status).toBe(404)
  })

  it('is refused for a Host that is not the public name, as every request is', async () => {
    const { socket, asked } = await up()
    const answer = await deliver(socket, '/hooks/github', ISSUE, {
      ...github(ISSUE),
      host: 'evil.example',
    })
    expect(answer.status).toBe(403)
    expect(asked.matched).toEqual([])
  })

  it('is told to slow down past the rate a source gets, said once, and asks nothing', async () => {
    const { one, socket, asked } = await up({ match: async () => [] })
    const forged = github(ISSUE, 'x', 'guess')
    for (let n = 0; n < HOOK_TRIES; n++) await deliver(socket, '/hooks/github', ISSUE, forged)
    const over = await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    expect(over.status).toBe(429)
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    await deliver(socket, '/hooks/github', ISSUE, github(ISSUE))
    const warned = one.told.filter(
      (told) => told.type === 'warning' && String(told.detail.message).includes('slow down'),
    )
    expect(warned).toHaveLength(1)
    expect(asked.matched).toEqual([])
  })
})
