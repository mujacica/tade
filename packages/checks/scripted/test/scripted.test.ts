import type { Check } from '@tade/checks-core'
import { testRunner } from '@tade/checks-core/conformance'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { makeScriptedRunner } from '../src/index.ts'

const check = (id: string, over: Partial<Check> = {}): Check => ({
  id,
  title: id,
  run: `echo ${id}`,
  alone: false,
  minutes: 1,
  required: true,
  ...over,
})

const CHECKS = {
  passes: check('passes'),
  fails: check('fails'),
  slow: check('slow', { minutes: 0.001 }),
  alone: check('alone', { alone: true }),
  lingers: check('lingers'),
}

testRunner(
  'scripted',
  () =>
    makeScriptedRunner({
      answers: {
        fails: { state: 'failed', tail: '8 failed', summary: '8 failed', code: 1 },
        slow: { ms: 5_000 },
        alone: { ms: 40 },
        lingers: { ms: 5_000 },
      },
      plan: [check('types'), check('tests', { needs: ['types'] })],
    }),
  {
    project: () => ({ name: 'demo', root: tmp('tade-scripted-') }),
    checks: CHECKS,
    missing: () => ({
      runner: makeScriptedRunner({ problem: 'install the thing and try again' }),
      project: { name: 'demo', root: tmp('tade-scripted-') },
    }),
  },
)

describe('a runner that answers from a table', () => {
  it('hands back the plan it was given, in the order needs imply', async () => {
    const runner = makeScriptedRunner({ plan: [check('types'), check('tests')] })
    const plan = await runner.plan(
      { name: 'demo', root: tmp('tade-scripted-') },
      { commit: 'abc', changed: [] },
    )
    expect(plan.map((one) => one.id)).toEqual(['types', 'tests'])
  })
})
