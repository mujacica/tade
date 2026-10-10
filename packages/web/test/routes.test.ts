import { describe, expect, it } from 'vitest'
import { ACTS, ASKS, DRAFTS, LIFECYCLE, ROUTES, routeFor, routesFor } from '../src/routes.ts'
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
  it('has exactly two non-GET routes, and they are these two by name', () => {
    const changing = ROUTES.filter((route) => route.method !== 'GET')
    expect(changing.map((route) => route.name).sort()).toEqual([...LIFECYCLE].sort())
    // Both are session lifecycle: this browser's own credential, created and
    // destroyed. A third one fails this test until somebody puts it in
    // `LIFECYCLE` deliberately, which is the conversation the claim is for.
    expect(changing.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/devices/:id',
      'POST /api/pair',
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
      '/api/settings',
      '/api/config',
      '/api/grant',
      '/api/intake',
      '/api/publish',
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

describe('the three tables a setting turns on', () => {
  it('puts nothing in the base table, so read-only stays an absence', () => {
    // Each of the three is a second table `routesFor` adds only where its own
    // setting says so, which is why `ROUTES` is still the list somebody checks
    // read-only against in forty lines.
    const paths = ROUTES.map((route) => route.path)
    for (const route of [...ACTS, ...ASKS, ...DRAFTS]) {
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
  })

  it('gives every saving route the draft scope, which no verb and no saying has', () => {
    for (const route of DRAFTS) expect(route.needs, route.path).toBe('draft')
    for (const route of [...ACTS, ...ASKS]) expect(route.needs, route.path).not.toBe('draft')
  })

  it('gives every route in the three tables exactly one of the three jobs', () => {
    // A route reaches a `WebActing` method, a `WebAsking` one or a
    // `WebDrafting` one, and never two: two would be a handler that had to
    // choose, which is the shape `carryOut` answers with a `404`.
    for (const route of [...ACTS, ...ASKS, ...DRAFTS]) {
      const jobs = [route.verb, route.says, route.saves].filter((one) => one !== undefined)
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
    const every = routesFor({ ...OFF, enabled: true, acting: true, talking: true, drafting: true })
    const paths = every.map((route) => route.path)
    for (const forbidden of [
      '/api/publish',
      '/api/draft/publish',
      '/api/draft/new',
      '/api/draft/remove',
      '/api/draft/reject',
      '/api/persona',
      '/api/grant',
      '/api/settings',
      '/api/accounts',
    ]) {
      expect(paths, forbidden).not.toContain(forbidden)
    }
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
