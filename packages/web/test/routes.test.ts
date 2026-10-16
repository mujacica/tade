import { describe, expect, it } from 'vitest'
import {
  ACTS,
  ASKS,
  DRAFTS,
  LIFECYCLE,
  PUSHES,
  ROUTES,
  routeFor,
  routesFor,
  SETTINGS,
} from '../src/routes.ts'
import { OFF, type Surface } from '../src/surface.ts'

// Read-only, enforced by absence, asserted in one file.
//
// DESIGN.md asked for "every entry is a GET", and that test cannot pass against
// DESIGN.md's own Phase 1 — which has a `POST` that mints a session and a
// `DELETE` that destroys one. What is asserted instead is the invariant the
// GET-only claim was reaching for, and it is the stronger of the two:
//
//   **No route mutates a project or a task.**

describe('the shape of the table', () => {
  it('has exactly the lifecycle routes as its non-GET routes, by name', () => {
    const changing = ROUTES.filter((route) => route.method !== 'GET')
    expect(changing.map((route) => route.name).sort()).toEqual([...LIFECYCLE].sort())
    // All four are session lifecycle: this browser's own credential, created,
    // destroyed and proved with its passkey. A fifth fails this test until
    // somebody puts it in `LIFECYCLE` deliberately, which is the conversation
    // the claim is for.
    expect(changing.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/devices/:id',
      'POST /api/pair',
      'POST /api/passkey/answer',
      'POST /api/passkey/challenge',
    ])
  })

  it('marks every non-GET route as mutating, and no GET route as one', () => {
    for (const route of ROUTES) expect(route.mutates, route.name).toBe(route.method !== 'GET')
  })

  it('has exactly one route that mints a credential, and it is the pairing route', () => {
    // DECISIONS §4.2: `/api/pair` cannot present a token it has not minted, so
    // it is the one route with no session to take one from. The exemption is
    // this route and no other, which is what this line is for.
    const opens = ROUTES.filter((route) => route.opens === true)
    expect(opens.map((route) => route.path)).toEqual(['/api/pair'])
  })

  it('never has a public mutating route that is not that one', () => {
    // The dangerous combination: no session needed *and* it changes something.
    // Exactly one route may be it, and it is the one whose authorisation is a
    // keypress at the machine.
    const both = ROUTES.filter((route) => route.public === true && route.mutates)
    expect(both.map((route) => route.name)).toEqual(['pair'])
    for (const route of both) expect(route.opens, route.name).toBe(true)
  })

  it('has one route that is answered with the worker, and it is at the root', () => {
    // A worker may only control paths under the folder it was served from, so
    // `/sw.js` is the only place one can be served for a page whose screens
    // are all at the root. It is public like the shell, carries no data and is
    // not a `document` — `assets.ts` reads that flag to decide which of the
    // two kinds of made answer a path is.
    const worker = ROUTES.filter((route) => route.name === 'worker')
    expect(worker.map((route) => `${route.method} ${route.path}`)).toEqual(['GET /sw.js'])
    expect(worker[0]?.public).toBe(true)
    expect(worker[0]?.mutates).toBe(false)
    expect(worker[0]?.document).toBeUndefined()
    expect(worker[0]?.path.split('/').length).toBe(2)
  })

  it('has exactly one route that owns everything under it, and it is the files', () => {
    const under = ROUTES.filter((route) => route.under === true)
    expect(under.map((route) => route.path)).toEqual(['/assets'])
  })

  it('needs no more than `read` for anything in this phase', () => {
    // The scope vocabulary has four words so that a verb can say it needs more
    // than one. Nothing in Phase 1 does, and the guard's trusted-origin rule
    // is written for the ones that will.
    for (const route of ROUTES) expect(route.needs, route.name).toBe('read')
  })

  it('serves no route that reads, writes or publishes anything of the machine’s', () => {
    // The absences, named: each of these is a `never remote` line of DESIGN
    // §9.1 and a route somebody could add without noticing they had crossed
    // one. By §10.8 a path not in the table is a `404`, so keeping them absent
    // costs nothing.
    const paths = ROUTES.map((route) => route.path)
    for (const forbidden of [
      '/api/config',
      '/api/grant',
      '/api/intake',
      '/api/publish',
      // `/api/push` is a **git** push, which is a `never remote` line. What a
      // device may ask about notifications is `/api/notify/...` in `PUSHES`,
      // deliberately spelt differently: two meanings of one word in a route
      // table is the ambiguity somebody resolves by guessing.
      '/api/push',
      '/api/merge',
      '/api/agent',
      '/api/run',
      '/api/command',
      '/api/secret',
      '/api/accounts',
      '/api/extensions',
      '/api/mcp',
      '/api/approvals',
      '/api/override',
    ])
      expect(paths, forbidden).not.toContain(forbidden)
  })

  it('reads the settings with one GET, and writes none of them', () => {
    // **The one read of the machine's own setup, and it used to be on the
    // list above.** It came off it deliberately: a `GET` like every other
    // read, the same for every device, with what it may see decided by that
    // device's own `settings` grant in the answer (`settingsFor`) and a key
    // never in it under any grant. Nothing in this table writes one — that is
    // `SETTINGS`, below, behind a setting of its own.
    const reading = ROUTES.filter((route) => route.path.startsWith('/api/settings'))
    expect(reading.map((route) => `${route.method} ${route.path}`)).toEqual(['GET /api/settings'])
    expect(reading[0]?.mutates).toBe(false)
    expect(reading[0]?.needs).toBe('read')
  })

  it('never lets a device revoke another: there is no route shaped to', () => {
    // The sign-out route takes an id and refuses any id but the caller's own
    // (`server.ts`), and there is no route at all for revoking by someone
    // else's — the thing that grants authority is never reachable from inside
    // the authority it granted.
    expect(ROUTES.some((route) => route.path === '/api/devices' && route.mutates)).toBe(false)
    expect(ROUTES.some((route) => route.name.includes('grant'))).toBe(false)
  })

  it('names each route once', () => {
    expect(new Set(ROUTES.map((route) => route.name)).size).toBe(ROUTES.length)
    expect(new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size).toBe(ROUTES.length)
  })
})

describe('the five tables a setting turns on', () => {
  it('puts nothing in the base table, so read-only stays an absence', () => {
    // Each of the four is a second table `routesFor` adds only where its own
    // setting says so, which is why `ROUTES` is still the list somebody checks
    // read-only against in forty lines.
    const paths = ROUTES.map((route) => route.path)
    for (const route of [...ACTS, ...ASKS, ...DRAFTS, ...PUSHES, ...SETTINGS]) {
      expect(paths, route.path).not.toContain(route.path)
    }
  })

  it('serves none of them with every setting off', () => {
    expect(routesFor(OFF)).toEqual(ROUTES)
  })

  it('serves each of them only where its own setting is on', () => {
    const on = (over: Partial<Surface>) =>
      routesFor({ ...OFF, enabled: true, ...over }).map((route) => route.path)
    expect(on({ acting: true })).toContain('/api/act/park')
    expect(on({ acting: true })).not.toContain('/api/draft/save')
    expect(on({ talking: true })).toContain('/api/ask/ask')
    expect(on({ talking: true })).not.toContain('/api/draft/save')
    // The one this slice adds, and the asymmetry worth asserting: a device
    // granted both acting tiers still has no path to save a draft.
    expect(on({ drafting: true })).toContain('/api/draft/save')
    expect(on({ drafting: true })).not.toContain('/api/act/park')
    expect(on({ acting: true, talking: true })).not.toContain('/api/draft/save')
    // The fourth, and the asymmetry worth asserting the other way round: a
    // device granted every acting tier has no path to subscribe either, and a
    // device that may subscribe has none to act.
    expect(on({ pushing: true })).toContain('/api/notify/subscribe')
    expect(on({ pushing: true })).toContain('/api/notify/forget')
    expect(on({ pushing: true })).not.toContain('/api/act/park')
    expect(on({ acting: true, talking: true, drafting: true })).not.toContain(
      '/api/notify/subscribe',
    )
    // The fifth: changing a setting is its own switch, and every other one on
    // at once still builds no path to it.
    expect(on({ configuring: true })).toEqual([
      ...ROUTES.map((route) => route.path),
      '/api/settings/change',
    ])
    expect(
      on({ acting: true, talking: true, drafting: true, pushing: true, installing: true }),
    ).not.toContain('/api/settings/change')
  })

  it('gives the changing route the configure scope, which nothing else needs', () => {
    // `configure` is implied by nothing: a device granted every acting tier, a
    // conversation and a draft has been granted things about work and not the
    // config — and nothing in the other four tables can be reached with it.
    expect(SETTINGS.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/settings/change',
    ])
    for (const route of SETTINGS) expect(route.needs, route.path).toBe('configure')
    for (const route of [...ROUTES, ...ACTS, ...ASKS, ...DRAFTS, ...PUSHES]) {
      expect(route.needs, route.path).not.toBe('configure')
    }
  })

  it('needs no more than read to be told, which is the honest scope', () => {
    // Being told that two things want you reveals nothing this device could
    // not already read. The trusted-origin layer the guard applies above
    // `read` is therefore not reached, and `admitPush` re-asks it instead —
    // which `test/pushed.test.ts` is what holds.
    for (const route of PUSHES) expect(route.needs, route.path).toBe('read')
  })

  it('has no route that asks for a notification to be sent', () => {
    // A device able to ask for one would be a device able to make this machine
    // POST to an address of its choosing, at a rate of its choosing — which is
    // the whole of what `endpoint.ts` exists to stop being interesting.
    const every = routesFor({
      ...OFF,
      enabled: true,
      acting: true,
      talking: true,
      drafting: true,
      pushing: true,
    })
    const paths = every.map((route) => route.path)
    for (const forbidden of [
      '/api/notify/send',
      '/api/notify/test',
      '/api/notify',
      '/api/notify/all',
      '/api/notify/devices',
    ]) {
      expect(paths, forbidden).not.toContain(forbidden)
    }
  })

  it('gives every saving route the draft scope, which no verb and no saying has', () => {
    for (const route of DRAFTS) expect(route.needs, route.path).toBe('draft')
    for (const route of [...ACTS, ...ASKS]) expect(route.needs, route.path).not.toBe('draft')
  })

  it('gives every route in the five tables exactly one of the five jobs', () => {
    // A route reaches a `WebActing` method, a `WebAsking` one, a `WebDrafting`
    // one, a `WebPushing` one or a `WebConfiguring` one, and never two: two
    // would be a handler that had to choose, which is the shape `carryOut`
    // answers with a `404`.
    for (const route of [...ACTS, ...ASKS, ...DRAFTS, ...PUSHES, ...SETTINGS]) {
      const jobs = [route.verb, route.says, route.saves, route.notifies, route.configures].filter(
        (one) => one !== undefined,
      )
      expect(jobs, route.path).toHaveLength(1)
      expect(route.method, route.path).toBe('POST')
      expect(route.mutates, route.path).toBe(true)
      // None of them is public: a save, an act and a message each need a
      // session, every time.
      expect(route.public, route.path).toBeUndefined()
    }
  })

  it('still has no route that publishes, grants or reaches a credential', () => {
    // The list `LOCAL_ONLY_ACTS` names, asserted against the whole of what
    // this listener can ever serve rather than trusted as a sentence.
    const every = routesFor({
      ...OFF,
      enabled: true,
      acting: true,
      talking: true,
      drafting: true,
      pushing: true,
      configuring: true,
    })
    const paths = every.map((route) => route.path)
    for (const forbidden of [
      '/api/publish',
      '/api/draft/publish',
      '/api/draft/new',
      '/api/draft/remove',
      '/api/draft/reject',
      '/api/persona',
      '/api/grant',
      '/api/config',
      '/api/accounts',
      '/api/settings/set',
      '/api/settings/key',
      '/api/settings/secret',
      '/api/settings/grant',
    ]) {
      expect(paths, forbidden).not.toContain(forbidden)
    }
    // **Everything under `/api/settings` with every capability on**: one read
    // and one change, and the change is the one that reaches `settingReach`'s
    // `open` tier and nothing else (`test/configured.test.ts` runs the tiers).
    expect(
      every
        .filter((route) => route.path.startsWith('/api/settings'))
        .map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual(['GET /api/settings', 'POST /api/settings/change'])
  })
})

describe('matching a path to a route', () => {
  it('finds the route for a method and a path', () => {
    expect(routeFor('GET', '/')?.route.name).toBe('shell')
    expect(routeFor('GET', '/pair')?.route.name).toBe('pair page')
    expect(routeFor('POST', '/api/pair')?.route.name).toBe('pair')
    expect(routeFor('GET', '/api/snapshot')?.route.name).toBe('snapshot')
  })

  it('finds nothing for the right path under the wrong method', () => {
    // A `404` and not a `405`, which would tell whoever is probing that the
    // path is real.
    expect(routeFor('POST', '/api/snapshot')).toBeNull()
    expect(routeFor('DELETE', '/')).toBeNull()
    expect(routeFor('PUT', '/api/pair')).toBeNull()
    expect(routeFor('PATCH', '/api/devices/abc')).toBeNull()
  })

  it('reads one segment into a parameter and never more', () => {
    expect(routeFor('DELETE', '/api/devices/00112233445566aa')?.params.id).toBe('00112233445566aa')
    // Two segments is not one: nothing matches, so nothing can smuggle a path
    // through a parameter.
    expect(routeFor('DELETE', '/api/devices/a/b')).toBeNull()
    expect(routeFor('DELETE', '/api/devices/')).toBeNull()
    expect(routeFor('DELETE', '/api/devices')).toBeNull()
  })

  it('reads everything under the files route as its tail', () => {
    expect(routeFor('GET', '/assets/boot.js')?.params.rest).toBe('boot.js')
    expect(routeFor('GET', '/assets/icons/a.svg')?.params.rest).toBe('icons/a.svg')
    // The folder itself is not a file.
    expect(routeFor('GET', '/assets')).toBeNull()
    expect(routeFor('GET', '/assetsx/a.js')).toBeNull()
  })

  it('finds nothing for a traversal, which the files route cannot represent', () => {
    // It *matches* the route, because the tail is just text — and then the
    // handler looks that text up in a map of the files that exist, which
    // answers nothing. A traversal here is not refused, it is unrepresentable.
    expect(routeFor('GET', '/assets/../../config.yaml')?.params.rest).toBe('../../config.yaml')
    expect(routeFor('GET', '/../../etc/passwd')).toBeNull()
  })
})
