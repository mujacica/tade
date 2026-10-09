import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPANIONS, CSP } from '../src/headers.ts'
import { BODY_MAX, CSRF_HEADER, pathOf, queryOf } from '../src/request.ts'
import type { Told } from '../src/server.ts'
import { webServer } from '../src/server.ts'
import { Tickets } from '../src/tickets.ts'
import { ask, BASE, closeAll, homeFor, pair, reading, said, start } from './harness.ts'

// **The door**: what a request gets, what it is refused, and what is written
// down about it. The credential itself — minting one, using it, losing it — is
// `pairing.test.ts`, over the same harness.
//
// The questions here are the ones only a real listener can answer: what bytes a
// browser is actually sent, which headers ride along, and whether the five
// layers at the door hold against a request that `fetch` cannot even make.

afterEach(closeAll)

describe('nothing listens unless it is turned on', () => {
  it('binds nothing at all when the surface is off', async () => {
    const home = await homeFor('off')
    const server = webServer({
      home,
      surface: { enabled: false, bind: 'loopback', port: 0, trustedHosts: [] },
      readingFor: reading,
      tickets: new Tickets(),
      confirm: async () => ({ let: false, why: 'refused' }),
    })
    expect(await server.listen()).toEqual([])
    expect(server.bound).toEqual([])
    await server.close()
  })

  it('binds loopback only by default, and both of its addresses', async () => {
    const one = await start()
    expect(one.server.bound.some((at) => at.startsWith('127.0.0.1'))).toBe(true)
    // Nothing on 0.0.0.0: `enabled` and `bind` are two decisions and the
    // second one defaults to this machine alone.
    expect(one.server.bound.some((at) => at.startsWith('0.0.0.0'))).toBe(false)
  })

  it('says so and listens nowhere when the port is already taken', async () => {
    const first = await start()
    const port = Number(first.host.split(':')[1])
    const home = await homeFor('busy')
    const told: Told[] = []
    const second = webServer({
      home,
      surface: { ...BASE, port },
      readingFor: reading,
      tickets: new Tickets(),
      tell: (line) => told.push(line),
      confirm: async () => ({ let: false, why: 'refused' }),
    })
    const bound = await second.listen()
    // A **named** warning and nothing bound on that address, never a quiet
    // bind somewhere else — a URL in somebody's hand that goes nowhere is
    // worse than a surface that said it could not come up.
    expect(bound.some((at) => at.startsWith(`127.0.0.1:${port}`))).toBe(false)
    const warning = told.find((line) => line.type === 'warning')
    expect(String(warning?.detail.warning)).toContain('could not listen')
    expect(String(warning?.detail.warning)).toContain('EADDRINUSE')
    await second.close()
  })
})
describe('what an unauthenticated request can get', () => {
  it('is the shell, and it carries no data', async () => {
    const one = await start()
    const answer = await ask(one, '/', { headers: { 'sec-fetch-site': 'none' } })
    expect(answer.status).toBe(200)
    const html = answer.text
    // Everything that is on the page arrives from a route that needs a
    // session. The shell is a script tag and some labels.
    for (const leak of ['tade/', 'checkout', 'working', 'blocked', '$', 'usd'])
      expect(html.toLowerCase(), leak).not.toContain(leak.toLowerCase())
    expect(html).toContain('boot.js')
  })

  it('is the pairing page, which is the same shell', async () => {
    const one = await start()
    const answer = await ask(one, '/pair', { headers: { 'sec-fetch-site': 'none' } })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('boot.js')
  })

  it('is the assets, and no data is in them either', async () => {
    const one = await start()
    for (const path of ['/assets/boot.js', '/assets/away.css', '/assets/frame.css']) {
      const answer = await ask(one, path)
      expect(answer.status, path).toBe(200)
      const text = answer.text
      expect(text.toLowerCase(), path).not.toContain('tade_away=')
    }
  })

  it('is nothing else at all: every data route is a 401', async () => {
    const one = await start()
    for (const path of ['/api/snapshot', '/api/notes', '/api/devices']) {
      const answer = await ask(one, path)
      expect(answer.status, path).toBe(401)
      expect(said(answer).error, path).toBe('no_session')
    }
  })

  it('is a 404 for anything that was never built, and for a wrong method', async () => {
    const one = await start()
    // One answer for four different things on purpose: a path nothing was
    // built at, a path under another method, an off capability, a missing
    // file. A `405` would say "that path exists".
    for (const [path, method] of [
      ['/api/task/tade-web/diff', 'GET'],
      ['/api/act/approve', 'POST'],
      ['/api/settings', 'GET'],
      ['/api/intake', 'POST'],
      ['/api/snapshot', 'POST'],
      ['/api/snapshot', 'DELETE'],
      ['/assets/nothing.js', 'GET'],
      ['/../../etc/passwd', 'GET'],
      ['/assets/../../../etc/passwd', 'GET'],
    ] as const) {
      const answer = await ask(one, path, { method })
      expect(answer.status, `${method} ${path}`).toBe(404)
    }
  })
})
describe('the headers on every answer', () => {
  it('carry the content policy, with nothing inline anywhere', async () => {
    const one = await start()
    for (const path of ['/', '/assets/boot.js', '/api/snapshot']) {
      const answer = await ask(one, path)
      expect(answer.headers['content-security-policy'], path).toBe(CSP)
      expect(CSP).not.toContain('unsafe-inline')
      expect(CSP).not.toContain('unsafe-eval')
      expect(CSP).toContain("default-src 'none'")
      for (const [name, value] of Object.entries(COMPANIONS)) {
        if (name === 'content-security-policy') continue
        expect(answer.headers[name], `${path} ${name}`).toBe(value)
      }
    }
  })

  it('carry them on a refusal too, because a refusal is a page as well', async () => {
    const one = await start()
    const answer = await ask(one, '/api/snapshot')
    expect(answer.status).toBe(401)
    expect(answer.headers['content-security-policy']).toBe(CSP)
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
  })

  it('never store an API answer, and always revalidate an asset', async () => {
    const one = await start()
    expect((await ask(one, '/api/snapshot')).headers['cache-control']).toBe('no-store')
    expect((await ask(one, '/assets/away.css')).headers['cache-control']).toBe('no-cache')
  })

  it('answer 304 to a browser that already has the asset', async () => {
    const one = await start()
    const first = await ask(one, '/assets/away.css')
    const etag = first.headers.etag
    expect(etag).toMatch(/^"[\w-]+"$/)
    const again = await ask(one, '/assets/away.css', {
      headers: { 'if-none-match': etag ?? '' },
    })
    expect(again.status).toBe(304)
    expect(again.headers['content-security-policy']).toBe(CSP)
  })
})
describe('cross-site, against a real listener', () => {
  it('refuses a cross-site form post with a good cookie', async () => {
    // The shape that tries: a simple-request `POST` from a page the owner
    // visited, carrying the cookie because the browser attached it. Refused by
    // the content type alone, before `Origin` or the token are even reached.
    const one = await start()
    const paired = await pair(one)
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])
      expect(
        (
          await ask(one, `/api/devices/${paired.device}`, {
            method: 'DELETE',
            headers: {
              cookie: paired.cookie,
              origin: 'https://evil.example',
              'content-type': type,
              [CSRF_HEADER]: paired.csrf,
            },
          })
        ).status,
        type,
      ).toBe(403)
  })

  it('refuses a rebinding read: the right address, the wrong name', async () => {
    const one = await start()
    const paired = await pair(one)
    const answer = await ask(one, '/api/snapshot', {
      headers: { host: 'evil.example', cookie: paired.cookie },
    })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('bad_origin')
  })

  it('refuses a mutation with the session but no token', async () => {
    const one = await start()
    const paired = await pair(one)
    const answer = await ask(one, `/api/devices/${paired.device}`, {
      method: 'DELETE',
      headers: {
        cookie: paired.cookie,
        origin: one.origin,
        'content-type': 'application/json',
      },
    })
    expect(answer.status).toBe(403)
  })

  it('ignores a forwarded header that claims another address', async () => {
    const one = await start()
    const paired = await pair(one)
    // If any of these were read, the Host allow-list and the trusted-origin
    // rule would both be whatever the attacker typed.
    const answer = await ask(one, '/api/snapshot', {
      headers: {
        cookie: paired.cookie,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '10.0.0.1',
      },
    })
    expect(answer.status).toBe(200)
  })

  it('says something once a peer keeps being refused, and not before', async () => {
    const one = await start()
    for (let at = 0; at < 2; at++) await ask(one, '/api/snapshot')
    expect(one.told.filter((told) => told.type === 'web_refused')).toHaveLength(0)
    await ask(one, '/api/snapshot')
    const said = one.told.filter((told) => told.type === 'web_refused')
    expect(said).toHaveLength(1)
    expect(said[0]?.detail.found).toBe(3)
    // And not again per request after that: a line per refusal is how a
    // journal becomes a request log nobody reads.
    for (let at = 0; at < 10; at++) await ask(one, '/api/snapshot')
    expect(one.told.filter((told) => told.type === 'web_refused')).toHaveLength(1)
  })

  it('never puts the host that was offered on the wire', async () => {
    const one = await start()
    const answer = await ask(one, '/api/snapshot', { headers: { host: 'evil.example' } })
    expect(JSON.stringify(said(answer))).not.toContain('evil.example')
    expect(String(one.told.find((told) => told.type === 'web_refused')?.detail.why ?? '')).toBe('')
  })
})
describe('resource exhaustion', () => {
  it('refuses a body over the cap, by what arrived and not by what was declared', async () => {
    const one = await start()
    const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
    const answer = await ask(one, '/api/pair', {
      method: 'POST',
      headers: { origin: one.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: ticket.value, label: 'x'.repeat(BODY_MAX * 2) }),
    })
    expect(answer.status).toBe(413)
    expect(said(answer).error).toBe('too_big')
    expect(one.asked).toHaveLength(0)
  })

  it('rate-limits pairing per address, and says how long to wait', async () => {
    const one = await start()
    one.answer = async () => ({ let: false, why: 'refused' })
    const headers = { origin: one.origin, 'content-type': 'application/json' }
    const statuses: number[] = []
    for (let at = 0; at < 7; at++) {
      const ticket = one.tickets.mint(`${one.origin}/pair`, Date.now())
      const answer = await ask(one, '/api/pair', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ticket: ticket.value, label: 'x' }),
      })
      statuses.push(answer.status)
      if (answer.status === 429) {
        expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0)
        expect(said(answer).after).toBeGreaterThan(0)
      }
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
    // Five tries, then a countdown: the limit is counted before the ticket is
    // looked at, so a stream of guesses costs a map entry and not a scan.
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true)
  })

  it('answers a closing window rather than hanging, and then nothing at all', async () => {
    const one = await start()
    const paired = await pair(one)
    await one.server.close()
    await expect(
      ask(one, '/api/snapshot', { headers: { cookie: paired.cookie } }),
    ).rejects.toThrow()
  })
})
describe('the query, read by exactly one route', () => {
  it('reads the notes scope out of it, which is not a credential', () => {
    // The one query parameter anything here reads. A *ticket* is never one —
    // it is in the fragment, which a browser does not send — and
    // `pairing.test.ts` asserts a ticket offered as a query parameter is
    // refused.
    expect(queryOf('/api/notes?scope=tade/web').get('scope')).toBe('tade/web')
    expect(queryOf('/api/notes').get('scope')).toBeNull()
    expect(queryOf('/api/notes?scope=a#b').get('scope')).toBe('a')
  })
})

describe('the path a request is for', () => {
  it('is null for anything that is not one', () => {
    for (const url of ['http://evil.example/', 'nope', '/a%2', '/a\\b', '/a\0b'])
      expect(pathOf(url), url).toBeNull()
  })

  it('is the path without its query or fragment', () => {
    expect(pathOf('/api/notes?scope=a')).toBe('/api/notes')
    expect(pathOf('/pair#t=abc')).toBe('/pair')
    expect(pathOf('/')).toBe('/')
  })

  it('decodes a segment, so an encoded traversal is seen for what it is', () => {
    // And then finds no route for it: `routes.ts` matches segment by segment
    // and nothing joins a parameter onto a path, so there is nothing here that
    // has to refuse `..` — only something that cannot represent it.
    expect(pathOf('/assets/%2e%2e%2f%2e%2e%2fconfig.yaml')).toBe('/assets/../../config.yaml')
  })
})

describe('nothing a crafted request can do moves a task', () => {
  /**
   * Every file under the home, by path and by its bytes.
   *
   * The whole of Tade's state about this machine lives under one folder, so
   * "nothing was mutated" is answerable as a fact rather than as a list of
   * routes somebody remembered to check. `web-devices.jsonl` is the one file
   * a request is allowed to append to, and it is named rather than excluded
   * by a pattern, so a *second* file appearing is a failure.
   */
  async function filesUnder(home: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const entry of await readdir(home, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue
      const at = join(entry.parentPath, entry.name)
      out[relative(home, at)] = await readFile(at, 'utf8')
    }
    return out
  }

  it('leaves every file Tade owns exactly as it was, session and all', async () => {
    const one = await start()
    const { cookie, csrf, device } = await pair(one)
    // A real task, written the way Tade writes one, so this is a test about a
    // file that exists rather than about an absence.
    const tasks = join(one.home, 'projects', 'shop', 'tasks', 'refunds')
    await mkdir(tasks, { recursive: true })
    await writeFile(join(tasks, 'task.yaml'), 'id: shop/refunds\nparked: false\ndone: said\n')
    const before = await filesUnder(one.home)

    // Everything somebody who holds a good session would try. Each is a shape
    // that has been a mutation route in some other control room: a verb on a
    // task path, a verb tunnelled through a header or a query, a form post, a
    // traversal out of the one route that owns a prefix, and the two routes
    // that really do write — aimed at somebody else's device.
    const crafted: {
      path: string
      method?: string
      headers?: Record<string, string>
      /** What it should answer, where that is not "there is nothing here". */
      answers?: number
    }[] = [
      { path: '/api/tasks/shop%2Frefunds', method: 'POST' },
      { path: '/api/tasks/shop%2Frefunds', method: 'PUT' },
      { path: '/api/tasks/shop%2Frefunds', method: 'PATCH' },
      { path: '/api/tasks/shop%2Frefunds', method: 'DELETE' },
      { path: '/api/task/shop/refunds/park', method: 'POST' },
      { path: '/api/queue/shop%2Frefunds/start', method: 'POST' },
      { path: '/api/approvals/a1/approve', method: 'POST' },
      { path: '/api/settings/surfaces.web.bind', method: 'POST' },
      { path: '/api/notes', method: 'POST' },
      // A verb smuggled past a router that reads one of these. Nothing here
      // reads either, so both are answered as the `GET` they are — which is a
      // `200`, and the file comparison at the end is what says the smuggled
      // verb did not also happen.
      {
        path: '/api/snapshot',
        method: 'GET',
        headers: { 'x-http-method-override': 'DELETE' },
        answers: 200,
      },
      { path: '/api/snapshot?_method=DELETE', method: 'GET', answers: 200 },
      // Out of the one route that owns everything under its prefix.
      { path: '/assets/../../projects/shop/tasks/refunds/task.yaml', method: 'GET' },
      { path: '/assets/%2e%2e%2f%2e%2e%2fweb-devices.jsonl', method: 'GET' },
      // Another device's credential, through the one route that destroys one.
      { path: '/api/devices/0011223344556677', method: 'DELETE' },
      { path: `/api/devices/${device}/../0011223344556677`, method: 'DELETE' },
    ]
    for (const one_ of crafted) {
      const answer = await ask(one, one_.path, {
        method: one_.method ?? 'GET',
        headers: {
          cookie,
          origin: one.origin,
          'content-type': 'application/json',
          [CSRF_HEADER]: csrf,
          ...one_.headers,
        },
        ...(one_.method === 'GET' || one_.method === undefined ? {} : { body: '{}' }),
      })
      // Not a `405` and not a `403` with a hint anywhere: an off capability is
      // not a thing to probe, so a path nothing was built at and a path that
      // exists under another method answer the same way.
      expect(
        one_.answers === undefined ? [403, 404] : [one_.answers],
        `${one_.method ?? 'GET'} ${one_.path} → ${answer.status}`,
      ).toContain(answer.status)
    }

    // The one query any route reads, with a traversal in it: a real `200`
    // with nothing in it, because a scope is a **name matched against a
    // note's own scope** and never a path anything is built from. Asserted
    // rather than left out of the barrage, because "it answered 404" and "it
    // answered the truth, which is that you have no notes there" are
    // different facts and only the second one is this design's.
    const notes = await ask(one, '/api/notes?scope=../../../etc/passwd', { headers: { cookie } })
    expect(notes.status).toBe(200)
    expect(said(notes).rows).toEqual([])

    expect(await filesUnder(one.home)).toEqual(before)
  })

  it('writes nothing at all for a barrage with no session', async () => {
    const one = await start()
    const before = await filesUnder(one.home)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      for (const path of ['/', '/api/snapshot', '/api/devices/0011223344556677', '/api/pair'])
        await ask(one, path, {
          method,
          headers: { origin: one.origin, 'content-type': 'application/json' },
          body: '{}',
        })
    expect(await filesUnder(one.home)).toEqual(before)
  })
})
