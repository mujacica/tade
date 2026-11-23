import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as install from '../src/assets/install.js'
import { PAGE_CSP } from '../src/connect-page.ts'
import { CSP } from '../src/headers.ts'

// Trusted Types: a browser that keeps them refuses a string handed to any
// script sink, so an HTML sink that appeared in the page tomorrow is refused
// rather than run. The one policy is the worker's, and it makes one URL.

const DIR = fileURLToPath(new URL('../src/assets/', import.meta.url))

/** What `install.js` says about its policy, as this test reads it. */
const { WORKER_POLICY, WORKER_URL, workerURLs } = install as unknown as {
  WORKER_POLICY: string
  WORKER_URL: string
  workerURLs: (types: unknown) => (url: string) => unknown
}

/** A browser's `trustedTypes`, as far as the page uses it: policies by name, each its own rules. */
function browserTypes(allowed: readonly string[]) {
  const made: string[] = []
  return {
    made,
    createPolicy(name: string, rules: { createScriptURL: (url: string) => string }) {
      if (!allowed.includes(name) || made.includes(name)) {
        throw new TypeError(`Policy ${name} disallowed.`)
      }
      made.push(name)
      return { createScriptURL: (url: string) => ({ trusted: rules.createScriptURL(url) }) }
    },
  }
}

describe('the content policy', () => {
  it('makes every script sink refuse a string, and allows the worker’s policy alone', () => {
    const parts = CSP.split('; ')
    expect(parts).toContain("require-trusted-types-for 'script'")
    expect(parts).toContain(`trusted-types ${WORKER_POLICY}`)
    expect(parts.filter((part) => part.startsWith('trusted-types '))).toHaveLength(1)
  })

  it('allows no policy at all on a connect page, whose script writes no markup', () => {
    const parts = PAGE_CSP.split('; ')
    expect(parts).toContain("require-trusted-types-for 'script'")
    expect(parts).toContain("trusted-types 'none'")
  })
})

describe('the worker’s policy', () => {
  it('makes the worker’s URL and refuses every other', () => {
    const types = browserTypes(['tade-worker'])
    const url = workerURLs(types)
    expect(url(WORKER_URL)).toEqual({ trusted: '/sw.js' })
    for (const other of ['/sw.js?x', 'https://evil.example/sw.js', '/assets/app.js', 'data:,x']) {
      expect(() => url(other), other).toThrow(TypeError)
    }
    // Made once: a second policy by the same name is what the browser refuses.
    expect(types.made).toEqual(['tade-worker'])
  })

  it('is the name the content policy allows, so a browser that keeps them makes it', () => {
    const allowed = /trusted-types ([^;]+)/.exec(CSP)?.[1]?.split(' ') ?? []
    expect(() => workerURLs(browserTypes(allowed))).not.toThrow()
  })

  it('hands the string over where the browser has no Trusted Types', () => {
    expect(workerURLs(undefined)(WORKER_URL)).toBe('/sw.js')
  })

  it('is what every registration in the page goes through', () => {
    for (const name of readdirSync(DIR, { recursive: true }).map(String)) {
      if (!name.endsWith('.js') || name === 'sw.js') continue
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const call of text.matchAll(/serviceWorker\.register\(([^,]*),/g)) {
        expect(call[1], name).toBe('workerURL()')
      }
    }
  })
})
