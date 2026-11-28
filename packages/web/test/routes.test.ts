import { describe, expect, it } from 'vitest'
import {
  ACTS,
  ASKS,
  CONNECTS,
  HOOKS,
  LIFECYCLE,
  OWNED,
  PUSHES,
  ROUTES,
  routeFor,
  routesFor,
  WINDOW,
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
    // All seven are session lifecycle: this browser's own credential, created,
    // destroyed and proved with its passkey, an owner's word that the person
    // is at another of their screens (`presence.ts`), a machine link's word
    // that its machine is up or closing (`seen.ts`), and a device's word that
    // its own page is being looked at (`looking.ts`) — none of which touches a
    // project or a task. An eighth fails this test until somebody
    // puts it in `LIFECYCLE` deliberately, which is the conversation the claim
    // is for.
    expect(changing.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/devices/:id',
      'POST /api/looking',
      'POST /api/pair',
      'POST /api/passkey/answer',
      'POST /api/passkey/challenge',
      'POST /api/presence',
      'POST /api/seen',
    ])
  })

  it('marks every non-GET route as mutating, and no GET route as one', () => {
    for (const route of ROUTES) expect(route.mutates, route.name).toBe(route.method !== 'GET')
  })

  it('has exactly one route that mints a credential, and it is the pairing route', () => {
    // `/api/pair` cannot present a token it has not minted, so
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

  it('has only the files owning everything under them: the assets and the drawing code', () => {
    // Everything under a prefix is Tade's own source, the same for everybody:
    // the page's assets, and the window's drawing a browser draws the full
    // view with (`/draw`). Each is public, read-only and a GET, and anything
    // it draws comes from a route that needs a session.
    const under = ROUTES.filter((route) => route.under === true)
    expect(under.map((route) => route.path)).toEqual(['/assets', '/draw'])
    for (const route of under) {
      expect(route.method, route.name).toBe('GET')
      expect(route.public, route.name).toBe(true)
      expect(route.mutates, route.name).toBe(false)
    }
  })

  it('needs no more than `read` for anything in this phase', () => {
    // The scope vocabulary has four words so that a verb can say it needs more
    // than one. Nothing in Phase 1 does, and the guard's trusted-origin rule
    // is written for the ones that will.
    for (const route of ROUTES) expect(route.needs, route.name).toBe('read')
  })

  it('serves no route that reads, writes or publishes anything of the machine’s', () => {
    // The absences, named: each of these is a `never remote` line
    // and a route somebody could add without noticing they had crossed
    // one. A path not in the table is a `404`, so keeping them absent
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

  it('reads and writes no setting', () => {
    // A phone reads and changes the settings in the window's own Settings,
    // drawn in the full view, so no route here touches one.
    expect(ROUTES.filter((route) => route.path.startsWith('/api/settings'))).toEqual([])
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

/** The full view's look: in every table, as the owner's and the connect tables are. */
const LOOK = WINDOW.filter((route) => route.windows === 'look')

describe('the three tables a setting turns on', () => {
  it('puts nothing in the base table, so read-only stays an absence', () => {
    // Each of the three is a second table `routesFor` adds only where its own
    // setting says so, which is why `ROUTES` is still the list somebody checks
    // read-only against in forty lines.
    const paths = ROUTES.map((route) => route.path)
    for (const route of [...ACTS, ...ASKS, ...PUSHES]) {
      expect(paths, route.path).not.toContain(route.path)
    }
  })

  it('serves none of them with every setting off', () => {
    // The owner's table is not one of them: no setting turns it on, because
    // the SSH key it stands for already reaches everything it does. Nor is
    // the connect table, which answers only this machine and a callback's word,
    // nor the full view's look, which asks for the window's state and does
    // nothing — its act is acting's (`WINDOW`).
    expect(routesFor(OFF)).toEqual([...ROUTES, ...LOOK, ...OWNED, ...CONNECTS])
  })

  it('serves each of them only where its own setting is on', () => {
    const on = (over: Partial<Surface>) =>
      routesFor({ ...OFF, enabled: true, ...over }).map((route) => route.path)
    expect(on({ acting: true })).toContain('/api/act/park')
    expect(on({ acting: true })).toContain('/api/window/act')
    expect(on({ talking: true })).not.toContain('/api/window/act')
    expect(on({ talking: true })).toContain('/api/ask/ask')
    expect(on({ talking: true })).not.toContain('/api/act/park')
    // The third, and the asymmetry worth asserting the other way round:
    // acting on builds no path to subscribe, and subscribing on none to act.
    expect(on({ pushing: true })).toContain('/api/notify/subscribe')
    expect(on({ pushing: true })).toContain('/api/notify/forget')
    expect(on({ pushing: true })).not.toContain('/api/act/park')
    expect(on({ acting: true, talking: true })).not.toContain('/api/notify/subscribe')
    // No setting builds a path to read or change a setting, or to save a draft:
    // a phone does both in the window's own panels, in the full view.
    const every = on({ acting: true, talking: true, pushing: true, installing: true })
    expect(every.filter((path) => path.startsWith('/api/settings'))).toEqual([])
    expect(every.filter((path) => path.startsWith('/api/draft'))).toEqual([])
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

  it('gives every route in the three tables exactly one of the three jobs', () => {
    // A route reaches a `WebActing` method, a `WebAsking` one or a `WebPushing`
    // one, and never two: two would be a handler that had to choose, which is
    // the shape `carryOut` answers with a `404`.
    for (const route of [...ACTS, ...ASKS, ...PUSHES]) {
      const jobs = [route.verb, route.says, route.notifies].filter((one) => one !== undefined)
      expect(jobs, route.path).toHaveLength(1)
      expect(route.method, route.path).toBe('POST')
      expect(route.mutates, route.path).toBe(true)
      // None of them is public: a save, an act and a message each need a
      // session, every time.
      expect(route.public, route.path).toBeUndefined()
    }
  })

  it('still has no route that publishes, grants or reaches a credential, but the owner’s', () => {
    // The list `LOCAL_ONLY_ACTS` names, asserted against the whole of what
    // this listener can ever serve rather than trusted as a sentence. The
    // exceptions are `OWNED`'s — the carry, and Settings › Accounts for every
    // machine (`accounts.ts`) — which are the SSH key's and are held below.
    const every = routesFor({
      ...OFF,
      enabled: true,
      acting: true,
      talking: true,
      pushing: true,
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
      '/api/settings/set',
      '/api/settings/key',
      '/api/settings/secret',
      '/api/settings/grant',
    ]) {
      expect(paths, forbidden).not.toContain(forbidden)
    }
    // Accounts are added, signed in and chosen only by the person: at this
    // machine's door as the SSH key's, or from a device they paired.
    const accounts = every.find((one) => one.path === '/api/accounts')
    expect(OWNED).toContain(accounts)
    expect(accounts).toMatchObject({ here: true })
    // **Nothing under `/api/settings` with every capability on**: a phone
    // changes a setting in the window's own Settings, in the full view.
    expect(every.filter((route) => route.path.startsWith('/api/settings'))).toEqual([])
  })
})

describe('the doorbells', () => {
  // A webhook is a source's server reaching this one over the internet, which
  // is what a public name is for and nothing else here is.
  it('is one path a source, under /hooks and never /api, built only where a public name is', () => {
    expect(HOOKS.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /hooks/github',
      'POST /hooks/slack',
      'POST /hooks/linear',
    ])
    expect(routesFor({ ...OFF, enabled: true })).not.toContain(HOOKS[0])
    const named = routesFor({ ...OFF, enabled: true, publicName: 'tade.example.com' })
    for (const route of HOOKS) expect(named, route.path).toContain(route)
  })

  it('needs no session and no scope above read, and does none of the five jobs', () => {
    for (const route of HOOKS) {
      expect(route.public, route.path).toBe(true)
      expect(route.mutates, route.path).toBe(true)
      expect(route.needs, route.path).toBe('read')
      expect(route.opens, route.path).toBeUndefined()
      expect(route.here, route.path).toBeUndefined()
      const jobs = [route.verb, route.says, route.notifies]
      expect(
        jobs.filter((one) => one !== undefined),
        route.path,
      ).toEqual([])
      expect(route.path.split('/').at(-1), route.path).toBe(route.rings)
    }
    // And no other table has a route that rings, so no other door is one.
    for (const route of [...ROUTES, ...ACTS, ...ASKS, ...PUSHES, ...OWNED]) {
      expect(route.rings, route.path).toBeUndefined()
    }
  })
})

describe('the owner’s table', () => {
  it('is sixteen routes, at this machine’s own door only, and none of the five jobs', () => {
    // The one route that can write a key (`carried.ts`), and the exception to
    // "no route reaches a credential" above; the one answer that is a way
    // into a lane (`attached.ts`), which every row a phone reads promises
    // never to be; the catch-up read from the cursor an owner's presence
    // wrote (`since.ts`); the person's notes shared, written into what every
    // agent here is told (`shared-notes.ts`); and where each project is
    // checked out, a path no phone reads (`repositories.ts`); one project as
    // this machine's window draws it, paths in it (`side.ts`); what is on disk in
    // it, the one owner's route that takes a path (`disk.ts`); what this machine
    // is, Tade started again on the code on disk now
    // (`restarted.ts`) or its orchestrator alone, what one of its watches has already found (`watch-seen.ts`), whose each duty is where a repository is a project on several machines (`duties.ts`), one of
    // its documents, and one of its tools that only reads, run with this
    // machine's own keys (`machine.ts`, `document.ts`, `tool-read.ts`); what
    // another machine of the person's has, kept here as a copy
    // (`inventory-told.ts`); its
    // public name's records, looked at now, which asks the world (`records.ts`);
    // and work another machine hands this one, the one route that makes work
    // (`taken.ts`); and a project it moves here, cloned and opened
    // (`opened.ts`); and a source's guided page and a press on it, for a
    // browser that cannot reach this machine's own door (`connected.ts`) — named
    // here, by path, so another cannot join them without this line changing.
    // What keeps them no wider than what already was is who may use them: an
    // owner, which is the SSH key, on the one door that key reaches, or a
    // paired phone — every one the person's own — asked what acting asks off
    // that door (`test/theirs.test.ts`).
    expect(OWNED.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/carry',
      'POST /api/attach',
      'POST /api/since',
      'POST /api/notes/share',
      'POST /api/feeds/share',
      'POST /api/projection',
      'POST /api/conversation',
      'POST /api/acts',
      'POST /api/acts/outbox',
      'POST /api/there/press',
      'POST /api/repositories',
      'POST /api/side',
      'POST /api/disk',
      'POST /api/machine',
      'POST /api/restart',
      'POST /api/orchestrator/restart',
      'POST /api/orchestrator/sign-in',
      'POST /api/accounts',
      'POST /api/inventory',
      'POST /api/watch/seen',
      'POST /api/duties',
      'POST /api/document',
      'POST /api/tool',
      'POST /api/records',
      'POST /api/take',
      'POST /api/open',
      'POST /api/connect',
    ])
    for (const route of OWNED) {
      expect(route.here, route.path).toBe(true)
      expect(route.mutates, route.path).toBe(true)
      expect(route.public, route.path).toBeUndefined()
      const jobs = [route.verb, route.says, route.notifies]
      expect(
        jobs.filter((one) => one !== undefined),
        route.path,
      ).toEqual([])
    }
  })
})

describe('the connect pages', () => {
  // Turning a source on is the person's, so the page and its
  // presses are this machine's alone, and where GitHub sends the browser back
  // is answered only for a word one of those presses minted (`connected.ts`).
  it('is a page, and each source’s presses and callbacks as its flow says, under /connect and never /api', () => {
    expect(CONNECTS.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /connect',
      'POST /connect/github/make',
      'POST /connect/github/install',
      'GET /connect/github/made',
      'GET /connect/github/installed',
      // Slack keeps what its own page shows the person, and comes back once.
      'POST /connect/slack/make',
      'POST /connect/slack/keep',
      'POST /connect/slack/install',
      'GET /connect/slack/installed',
      // Linear keeps its client id the same way, and comes back to any door.
      'POST /connect/linear/make',
      'POST /connect/linear/keep',
      'POST /connect/linear/install',
      'GET /connect/linear/installed',
    ])
    // Each carries which press or callback it is, so nothing reads it out of a name.
    for (const route of CONNECTS.slice(1)) {
      expect(route.press ?? route.back, route.path).toBe(route.path.split('/').at(-1))
    }
  })

  it('answers the page and its presses on this machine alone, and the callbacks on any door', () => {
    for (const route of CONNECTS) {
      expect(route.needs, route.path).toBe('read')
      expect(route.public, route.path).toBeUndefined()
      expect(route.opens, route.path).toBeUndefined()
      expect(route.rings, route.path).toBeUndefined()
      const jobs = [route.verb, route.says, route.notifies]
      expect(
        jobs.filter((one) => one !== undefined),
        route.path,
      ).toEqual([])
      if (route.connects === 'back') {
        expect(route.method, route.path).toBe('GET')
        expect(route.here, route.path).toBeUndefined()
      } else {
        expect(route.here, route.path).toBe(true)
        expect(route.mutates, route.path).toBe(route.connects === 'press')
      }
    }
    // And no other table has a route that connects anything.
    for (const route of [...ROUTES, ...ACTS, ...ASKS, ...PUSHES, ...OWNED]) {
      expect(route.connects, route.path).toBeUndefined()
    }
  })
})

describe('reading a conversation further back', () => {
  it('is one GET at read, changing nothing', () => {
    const found = ROUTES.find((one) => one.name === 'chat')
    expect(found).toMatchObject({ method: 'GET', needs: 'read', mutates: false })
    expect(found?.public).toBeUndefined()
    expect(found?.here).toBeUndefined()
    expect(routeFor('GET', '/api/chat')?.route.name).toBe('chat')
    // Nothing else reads a conversation, and nothing writes one.
    expect(routeFor('POST', '/api/chat')).toBeNull()
    expect(routeFor('GET', '/api/agent/sentry/away-projection/earlier')).toBeNull()
    expect(routeFor('GET', '/api/agent/sentry/away-projection/moments')).toBeNull()
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
