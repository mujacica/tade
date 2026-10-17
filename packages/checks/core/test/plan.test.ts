import { describe, expect, it } from 'vitest'
import { type inOrder, matches, planFor } from '../src/plan.ts'
import type { RunnerError } from '../src/port.ts'

// What of a project's checks would run for a commit. Pure: handed the checks,
// it answers with the ones that apply, in an order that respects `needs`.

const check = (id: string, extra: Partial<Parameters<typeof inOrder>[0][number]> = {}) => ({
  id,
  title: id,
  run: 'true',
  alone: false,
  minutes: 1,
  required: true,
  ...extra,
})

describe('what would run for a commit', () => {
  it('puts what is needed before what needs it', () => {
    const ordered = planFor([check('tests', { needs: ['types'] }), check('types')])
    expect(ordered.map((one) => one.id)).toEqual(['types', 'tests'])
  })

  it('refuses a cycle, naming it', () => {
    try {
      planFor([check('a', { needs: ['b'] }), check('b', { needs: ['a'] })])
      expect.unreachable()
    } catch (err) {
      expect((err as RunnerError).trouble).toBe('refused')
      expect((err as RunnerError).message).toContain('→')
    }
  })

  it('leaves out what the changed paths do not touch, and keeps it when nothing is known', () => {
    const docs = [check('docs', { when: ['docs/**', '*.md'] })]
    expect(planFor(docs, { changed: ['src/a.ts'] })).toEqual([])
    expect(planFor(docs, { changed: ['docs/a/b.md'] })).toHaveLength(1)
    expect(planFor(docs, { changed: ['README.md'] })).toHaveLength(1)
    // Narrowing on an unknown is how a check silently stops running.
    expect(planFor(docs)).toHaveLength(1)
  })

  it('runs only what was asked for, and says so when that is nothing it has', () => {
    const all = [check('format'), check('tests')]
    expect(planFor(all, { only: ['tests'] }).map((one) => one.id)).toEqual(['tests'])
    expect(() => planFor(all, { only: ['nope'] })).toThrow(/no check called nope/)
  })

  it('ignores a `needs` naming a check that is not here', () => {
    // A step a filter left out, or one somebody renamed: the order it wanted
    // cannot be honoured and the check still runs, rather than disappearing.
    expect(planFor([check('tests', { needs: ['gone'] })]).map((one) => one.id)).toEqual(['tests'])
  })
})

describe('the full run and the related run', () => {
  const checks = [
    check('pre-commit'),
    check('format'),
    check('tests'),
    check('related', { required: false, related: true }),
  ]
  const ids = (plan: { id: string }[]) => plan.map((one) => one.id)

  it('leaves the related check out of the full run, which runs every test it would', () => {
    expect(ids(planFor(checks))).toEqual(['pre-commit', 'format', 'tests'])
  })

  it('is the commit hook and the related check, and nothing else, when the related run is asked for', () => {
    expect(ids(planFor(checks, { related: true }))).toEqual(['pre-commit', 'related'])
  })

  it('runs a check somebody named, whichever run it belongs to', () => {
    expect(ids(planFor(checks, { only: ['related'] }))).toEqual(['related'])
    expect(ids(planFor(checks, { only: ['tests'], related: true }))).toEqual(['tests'])
  })
})

describe('globs', () => {
  it('matches the way people expect', () => {
    expect(matches('docs/**', 'docs/a/b.md')).toBe(true)
    expect(matches('docs/**', 'docs/a.md')).toBe(true)
    expect(matches('*.md', 'README.md')).toBe(true)
    expect(matches('*.md', 'docs/README.md')).toBe(false)
    expect(matches('packages/*/src/*.ts', 'packages/core/src/a.ts')).toBe(true)
  })
})
