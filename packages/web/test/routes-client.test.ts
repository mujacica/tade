import { describe, expect, it } from 'vitest'
import { agentPath, PAGE_OF, PLAIN, pathOf, TITLES, viewOf } from '../src/assets/routes.js'
import { titleFor } from '../src/assets/shell.js'
import { ROUTES, routeFor } from '../src/routes.ts'

// The page's own router, and the one property that cannot be checked in a
// browser without reloading it: **every screen is a path the server serves.**
//
// A client route the server does not serve is a screen that works until
// somebody reloads it or opens the link on another device, and then `404`s.
// That is the worst kind of broken, because every test that never reloads
// passes. So the two tables are asserted equal here, in both directions.
//
// The page has two screens (§10 T5 of the Duo plan): the overview and
// pairing. Everything else is a panel of the window, in the full view.

/**
 * The views that are not places, and so have no path on either side.
 *
 * `nowhere` is a path this router does not know — an old bookmark of a page
 * that went, drawn rather than guessed at — and `lastSeen` is a cold open with
 * nothing answering, drawn out of what this device kept. Neither can be
 * linked to, and a `<title>` is still owed for both, which is why they are in
 * `TITLES` and named here instead.
 */
const NOT_A_PLACE = ['nowhere', 'lastSeen']

/** The views the router can be on, read off the titles it has words for. */
const VIEWS = Object.keys(TITLES).filter((view) => !NOT_A_PLACE.includes(view))

describe('every screen is a path the machine serves', () => {
  it('is the overview and pairing, and nothing else', () => {
    expect(VIEWS.sort()).toEqual(['now', 'pair'])
    expect(PLAIN).toEqual(['pair'])
    expect(PAGE_OF).toEqual({ now: 'overview' })
  })

  it('serves the shell at every view the router knows', () => {
    for (const view of VIEWS) {
      const path = pathOf({ view })
      const found = routeFor('GET', path)
      expect(found, `${view} → ${path}`).not.toBeNull()
      expect(found?.route.document, `${view} → ${path}`).toBe(true)
    }
  })

  it('knows a screen for every document path the machine serves', () => {
    // The other direction: a path the server answers with the shell and the
    // router does not know is a page that loads and then says it knows nothing.
    const documents = ROUTES.filter((one) => one.document === true)
    expect(documents.map((one) => one.path)).toEqual(['/', '/pair'])
    for (const route of documents) expect(viewOf(route.path).view, route.path).not.toBe('nowhere')
  })

  it('serves no document route under any method but GET', () => {
    for (const route of ROUTES.filter((one) => one.document === true)) {
      expect(route.method, route.path).toBe('GET')
      expect(route.mutates, route.path).toBe(false)
      // Public, and what makes that safe is that the shell carries no data.
      expect(route.public, route.path).toBe(true)
    }
  })

  it('serves no page that went: an old bookmark is a 404, not a shell that says nothing', () => {
    for (const path of ['/spend', '/t/tade/window', '/p/tade', '/talk', '/settings', '/plans']) {
      expect(routeFor('GET', path), path).toBeNull()
    }
  })
})

describe('reading a path', () => {
  it('reads the overview, with or without a trailing slash', () => {
    expect(viewOf('/')).toEqual({ view: 'now' })
    expect(viewOf('')).toEqual({ view: 'now' })
    expect(viewOf('/pair')).toEqual({ view: 'pair' })
    expect(viewOf('/pair/')).toEqual({ view: 'pair' })
  })

  it('is nowhere for a path it does not know, rather than the overview', () => {
    for (const path of ['/spend', '/t/tade/window', '/pair/x', '/draw/']) {
      expect(viewOf(path).view, path).toBe('nowhere')
    }
  })

  it('round-trips every view it can be on', () => {
    for (const view of VIEWS) expect(viewOf(pathOf({ view }))).toEqual({ view })
  })

  it('titles every view, and the two that are not places', () => {
    expect(titleFor({ view: 'now' })).toBe('Overview · Tade')
    expect(titleFor({ view: 'nowhere' })).toBe('Nothing here · Tade')
    expect(titleFor({ view: 'lastSeen' })).toBe('Last seen · Tade')
  })
})

describe('an agent, opened in the full view', () => {
  it('is the full view with the agent named, its id escaped', () => {
    expect(agentPath('tade/window')).toBe('/draw/?agent=tade%2Fwindow')
    // A name with what a query would read as its own, escaped whole.
    expect(agentPath('tade/a&b=c')).toBe('/draw/?agent=tade%2Fa%26b%3Dc')
  })

  it('carries another machine in front of the id, as the window’s own rows do', () => {
    // `there.ts` in `@tade/app`: `@` the machine, the unit separator, the id there.
    const path = agentPath('tade/window', 'vps')
    expect(new URL(path, 'http://here').searchParams.get('agent')).toBe('@vps\u001ftade/window')
  })

  it('is a path this page does not draw, so a press on it goes to the full view’s document', () => {
    expect(viewOf(agentPath('tade/window').replace(/\?.*$/, '')).view).toBe('nowhere')
  })
})
