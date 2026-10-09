import { describe, expect, it } from 'vitest'
import {
  MORE,
  NAV,
  navFor,
  pathOf,
  safeHref,
  TITLES,
  taskPath,
  viewOf,
} from '../src/assets/routes.js'
import { ROUTES, routeFor } from '../src/routes.ts'

// The page's own router, and the one property that cannot be checked in a
// browser without reloading it: **every screen is a path the server serves.**
//
// A client route the server does not serve is a screen that works until
// somebody reloads it or opens the link on another device, and then `404`s.
// That is the worst kind of broken, because every test that never reloads
// passes. So the two tables are asserted equal here, in both directions.

/** The views the router can be on, read off the titles it has words for. */
const VIEWS = Object.keys(TITLES).filter((view) => view !== 'nowhere')

describe('every screen is a path the machine serves', () => {
  it('serves the shell at every view the router knows', () => {
    for (const view of VIEWS) {
      const path = pathOf({ view, project: 'tade', task: 'away-readonly-ui' })
      const found = routeFor('GET', path)
      expect(found, `${view} → ${path}`).not.toBeNull()
      expect(found?.route.document, `${view} → ${path}`).toBe(true)
    }
  })

  it('knows a screen for every document path the machine serves', () => {
    // The other direction: a path the server answers with the shell and the
    // router does not know is a page that loads and then says it knows nothing.
    for (const route of ROUTES.filter((one) => one.document === true)) {
      const path = route.path.replace(':project', 'tade').replace(':task', 'away-readonly-ui')
      expect(viewOf(path).view, route.path).not.toBe('nowhere')
    }
  })

  it('serves no document route under any method but GET', () => {
    for (const route of ROUTES.filter((one) => one.document === true)) {
      expect(route.method, route.path).toBe('GET')
      expect(route.mutates, route.path).toBe(false)
      // Public, and what makes that safe is that the shell carries no data.
      expect(route.public, route.path).toBe(true)
    }
  })

  it('navigates to a view every navigation entry names', () => {
    for (const one of [...NAV, ...MORE]) {
      expect(VIEWS, one.view).toContain(one.view)
      expect(routeFor('GET', pathOf({ view: one.view })), one.view).not.toBeNull()
    }
  })
})

describe('reading a path', () => {
  it('reads the overview, with or without a trailing slash', () => {
    expect(viewOf('/')).toEqual({ view: 'now' })
    expect(viewOf('')).toEqual({ view: 'now' })
  })

  it('reads a project and a task out of their paths', () => {
    expect(viewOf('/p/tade')).toEqual({ view: 'project', project: 'tade' })
    expect(viewOf('/t/tade/away-readonly-ui')).toEqual({
      view: 'task',
      project: 'tade',
      task: 'away-readonly-ui',
    })
  })

  it('decodes a name that had to be escaped, and refuses one that smuggles a path', () => {
    expect(viewOf('/p/my%20project')).toEqual({ view: 'project', project: 'my project' })
    // A name is **one segment**. A decoded slash would be a second segment
    // arriving through a parameter, which is the shape every path bug has.
    expect(viewOf('/p/a%2Fb').view).toBe('nowhere')
    expect(viewOf('/t/a%2Fb/c').view).toBe('nowhere')
    expect(viewOf('/p/%E0%A4%A').view).toBe('nowhere')
  })

  it('is nowhere for a path it does not know, rather than the overview', () => {
    // Quietly landing on the overview is a link that looks like it worked.
    for (const path of ['/nope', '/p', '/p/a/b', '/t/a', '/t/a/b/c', '/queue/x']) {
      expect(viewOf(path).view, path).toBe('nowhere')
    }
  })

  it('round-trips every view it can be on', () => {
    for (const view of VIEWS) {
      const where = { view, project: 'tade', task: 'away-readonly-ui' }
      expect(viewOf(pathOf(where)), view).toMatchObject({ view })
    }
  })

  it('reads a task id into its own screen’s path', () => {
    expect(taskPath('tade/away-readonly-ui')).toBe('/t/tade/away-readonly-ui')
    // A task id is `<project>/<task>` and the task half may itself hold a
    // slash, so the split is at the first one and the rest is escaped.
    expect(taskPath('tade/a/b')).toBe('/t/tade/a%2Fb')
    expect(taskPath('nothing')).toBe('/')
  })

  it('lights the overview’s own entry for a project and a task', () => {
    expect(navFor({ view: 'project' })).toBe('now')
    expect(navFor({ view: 'task' })).toBe('now')
    expect(navFor({ view: 'queue' })).toBe('queue')
  })
})

describe('the navigation', () => {
  it('is four entries plus More, which is what fits 360px with 44px targets', () => {
    expect(NAV).toHaveLength(4)
  })

  it('names each view once across both lists', () => {
    const views = [...NAV, ...MORE].map((one) => one.view)
    expect(new Set(views).size).toBe(views.length)
  })

  it('gives every entry a word, never a glyph alone', () => {
    for (const one of [...NAV, ...MORE]) {
      expect(one.label, one.view).not.toBe('')
      expect(one.mark, one.view).not.toBe('')
    }
  })
})

describe('the one outbound link in the design', () => {
  it('allows https and nothing else', () => {
    expect(safeHref('https://github.com/mujacica/tade/pull/412')).toBe(
      'https://github.com/mujacica/tade/pull/412',
    )
  })

  it('refuses every scheme that would turn a link into script or a payload', () => {
    // The URL came from the forge, which makes it the one string on the page
    // written by something off this machine. Parsed rather than prefix-matched,
    // because `HtTpS:` and `https:/\evil` are both things a prefix check gets
    // wrong.
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'http://github.com/x',
      'blob:https://github.com/x',
      '//github.com/x',
      '',
      'not a url',
    ]) {
      expect(safeHref(url), url).toBeNull()
    }
  })

  it('hands back what the parser made of it, never the string it was given', () => {
    // A `javascript:` URL is not the only way an `href` goes wrong: the raw
    // string a forge sent must not reach the attribute even when its scheme is
    // fine, because every browser normalises one differently. What goes in the
    // `href` is what `URL` made of it.
    expect(safeHref('https:/\\github.com')).toBe('https://github.com/')
    expect(safeHref('HTTPS://GitHub.com/x')).toBe('https://github.com/x')
  })

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['https://x']]) {
      expect(safeHref(value as unknown as string), String(value)).toBeNull()
    }
  })
})
