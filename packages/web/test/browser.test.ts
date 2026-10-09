import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../src/routes.ts'
import { allUnrun, CHECKS, exitFor, LOOKS, sayReport, WIDTHS, worstOf } from './browser-plan.ts'

// The browser harness, held to the one property that makes it worth having:
// **a machine with no browser reports `unrun`, never a pass.**
//
// This suite stays offline and drives no browser. What it asserts is the
// reporting — because the failure mode of an accessibility harness is not that
// it finds the wrong things, it is that it silently finds nothing and the run
// goes green. A report whose last line says `PASSED` on a machine that never
// opened a browser is worse than having no harness at all, and that is the
// exact shape this file makes impossible.
//
// It also holds the plan to the route table, so a screen added to the server
// and not to the harness cannot happen.

const run = promisify(execFile)
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'browser.ts')

describe('the plan', () => {
  it('looks at every screen the machine serves', () => {
    const documents = ROUTES.filter((route) => route.document === true)
    expect(LOOKS).toHaveLength(documents.length)
    for (const route of documents) {
      expect(
        LOOKS.map((look) => look.name),
        route.name,
      ).toContain(route.name.replace(/\s+/g, '-'))
    }
  })

  it('fills a parameter with a name the fixtures actually have', () => {
    // Otherwise the project and the task screen are looked at empty, which is
    // the one state that cannot show a layout problem.
    const task = LOOKS.find((look) => look.name === 'task-page')
    expect(task?.path).toBe('/t/sentry/away-projection')
    expect(LOOKS.every((look) => !look.path.includes(':'))).toBe(true)
  })

  it('includes the narrowest width the brief names, and marks it as the narrow one', () => {
    const narrow = WIDTHS.filter((one) => one.narrow === true)
    expect(narrow).toHaveLength(1)
    expect(narrow[0]?.width).toBe(360)
    // And the two the rail changes shape at, so both arrangements are looked at.
    expect(WIDTHS.map((one) => one.width)).toEqual([360, 834, 1440])
  })
})

describe('a report', () => {
  it('says unrun for every check when there is no browser, with the reason', () => {
    const why = 'playwright is not installed on this machine'
    const findings = allUnrun(why)
    expect(findings).toHaveLength(CHECKS.length)
    for (const one of findings) {
      expect(one.verdict).toBe('unrun')
      expect(one.said).toBe(why)
    }
  })

  it('never reads as a pass when anything was unrun', () => {
    // The sentence somebody quotes is the last one, so that is the one held.
    const said = sayReport(allUnrun('no browser'))
    expect(said).toContain('UNRUN')
    expect(said).not.toContain('PASSED')
    expect(worstOf(allUnrun('no browser'))).toBe('unrun')
  })

  it('is unrun even when one check passed and another could not be asked', () => {
    const mixed = [
      { check: 'landmarks', where: 'now @ phone', verdict: 'pass' as const, said: 'ok' },
      { check: 'axe', where: '—', verdict: 'unrun' as const, said: 'axe-core is not installed' },
    ]
    expect(worstOf(mixed)).toBe('unrun')
    expect(sayReport(mixed)).not.toContain('PASSED')
  })

  it('is a failure the moment anything failed, whatever else was unrun', () => {
    const mixed = [
      { check: 'axe', where: '—', verdict: 'unrun' as const, said: 'no axe' },
      { check: 'sideways', where: 'now @ phone', verdict: 'fail' as const, said: '40px over' },
    ]
    expect(worstOf(mixed)).toBe('fail')
    expect(sayReport(mixed)).toContain('FAILED')
  })

  it('is a pass only when every check ran and none failed', () => {
    const all = CHECKS.map((check) => ({
      check,
      where: 'now @ phone',
      verdict: 'pass' as const,
      said: 'ok',
    }))
    expect(worstOf(all)).toBe('pass')
    expect(sayReport(all)).toContain('PASSED')
  })

  it('is unrun for an empty report, because nothing asked is not nothing wrong', () => {
    expect(worstOf([])).toBe('unrun')
  })

  it('exits 0 for a pass, 1 for a failure and 2 for a run that could not be made', () => {
    // Three codes rather than two: a build that cannot tell "the page is
    // broken" from "nobody looked" is a build that treats them the same.
    expect(exitFor('pass')).toBe(0)
    expect(exitFor('fail')).toBe(1)
    expect(exitFor('unrun')).toBe(2)
  })

  it('names what it could not do, one row per check', () => {
    const said = sayReport(allUnrun('playwright is not installed on this machine'))
    for (const check of CHECKS) expect(said, check).toContain(check)
    expect(said).toContain('playwright is not installed')
  })
})

describe('the harness itself', () => {
  it('ships no browser dependency into this repository', () => {
    // Playwright's install pulls hundreds of megabytes of browser onto every
    // contributor's machine and into every CI job. This repository holds the
    // line that `pnpm install` runs two scripts and installs nothing else, so
    // the harness is optional **on the machine** and says so when it is absent.
    const root = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
    )
    const named = { ...root.dependencies, ...root.devDependencies }
    for (const one of ['playwright', '@playwright/test', 'axe-core', 'puppeteer']) {
      expect(Object.keys(named), one).not.toContain(one)
    }
    const mine = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    for (const one of ['playwright', 'axe-core']) {
      expect(Object.keys({ ...mine.dependencies, ...mine.devDependencies }), one).not.toContain(one)
    }
  })

  it('says how to install what it needs, where somebody reading it will look', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    expect(text).toContain('pnpm add -D')
    expect(text).toContain('playwright install chromium')
  })

  it('runs, reports unrun, and exits 2 when no browser can be started', async () => {
    // The real script, in its own process, with a browser that cannot be
    // there. **Pointed at a path that does not exist on purpose**, so this is
    // the same verdict on a runner with nothing installed and on a laptop with
    // Playwright and three browsers — a test whose answer depended on the
    // machine would be green here and red for whoever has one.
    //
    // There are two ways to have no browser and the reason differs: the
    // package is not there at all, or it is and no binary is behind it. Both
    // are `unrun` and both say which, so what is asserted is that it is one of
    // them — not which machine this happens to be.
    //
    // The `unrun` path is the one that runs in CI for ever, so a throw in it
    // would be a harness nobody ever sees work, and this is the only thing
    // that notices.
    const answer = await run('node', [SCRIPT], {
      timeout: 60_000,
      env: { ...process.env, TADE_BROWSER: '/nowhere/at/all/not-a-browser' },
    }).catch((problem: { code?: number; stdout?: string }) => problem)
    const out = 'stdout' in answer ? (answer.stdout ?? '') : ''
    expect(out).toContain('the away view, in a real browser')
    expect(out).toContain('UNRUN')
    expect(out).toMatch(/playwright is not installed|a browser could not be started/)
    expect(out).not.toContain('PASSED')
    expect('code' in answer ? answer.code : 0).toBe(2)
  }, 70_000)
})
