import { describe, expect, it } from 'vitest'
import {
  calledAfter,
  followRenames,
  idFor,
  normaliseCommand,
  sameCommand,
} from '../src/identity.ts'
import type { Check, CheckRun } from '../src/port.ts'

// What a check is called, and the one thing that makes a name safe as an id.
//
// The objection to a step name being an id is that renaming a step orphans
// every run recorded under the old name. `followRenames` is the answer, and it
// is `carryOver`'s reasoning one level up: a run stands for the check whose
// command it ran. So the cases worth writing are the ones where relabelling
// would have to *guess* — because a guess here draws a green tick.

const check = (id: string, run: string, over: Partial<Check> = {}): Check => ({
  id,
  title: id,
  run,
  alone: true,
  minutes: 10,
  required: true,
  ...over,
})

const run = (id: string, over: Partial<CheckRun> = {}): CheckRun => ({
  id: `abc:${id}:here:1`,
  check: id,
  commit: 'abc',
  state: 'passed',
  where: { kind: 'here', runner: 'local', host: 'mbp' },
  required: true,
  startedAt: null,
  finishedAt: null,
  code: 0,
  summary: null,
  by: 'you',
  ...over,
})

describe('a command as identity', () => {
  it('takes off the wrapper that only says how to reach the program', () => {
    expect(normaliseCommand('pnpm exec biome ci .')).toBe('biome ci .')
    expect(normaliseCommand('npx --yes tsc -p .')).toBe('tsc -p .')
    expect(normaliseCommand('bundle exec rspec')).toBe('rspec')
    // Repeatedly: `pnpm run check` can hold a `pnpm exec`, and both exist.
    expect(normaliseCommand('npx pnpm exec vitest run')).toBe('vitest run')
  })

  it('reads two spellings of one command as one command', () => {
    // A hook and a workflow step that spell it differently are one check, so a
    // rename can be followed across either of them.
    expect(sameCommand('pnpm exec biome ci .', '  biome   ci .  ')).toBe(true)
    expect(sameCommand('pnpm test', 'pnpm test -- --watch')).toBe(false)
  })

  it('leaves a command it does not recognise exactly as it is', () => {
    // Deliberately not a shell parse: anything cleverer would start deciding
    // two different commands are the same, which is the unsafe direction.
    expect(normaliseCommand('make test ARGS="-v"')).toBe('make test ARGS="-v"')
  })
})

describe('what to call a step nobody named', () => {
  it('is the program, or the script an interpreter runs', () => {
    expect(calledAfter('pnpm exec biome ci .')).toBe('biome')
    expect(calledAfter('node scripts/coverage.ts')).toBe('coverage')
    // The first thing that is not a flag, so `-m pytest` names the module and
    // not the interpreter that loads it.
    expect(calledAfter('python3 -m pytest')).toBe('pytest')
    expect(calledAfter('node --test scripts/check.mjs')).toBe('check')
    expect(calledAfter('./scripts/verify.sh')).toBe('verify-sh')
    expect(calledAfter('')).toBe('check')
  })

  it('is the last resort: a named step keeps its name', () => {
    const taken = new Set<string>()
    expect(idFor('Formatting and lint', 'pnpm exec biome ci .', taken)).toBe('formatting-and-lint')
    expect(idFor('', 'pnpm test', taken)).toBe('pnpm')
    // And never the same twice, because two rows with one id is one row.
    expect(idFor('', 'pnpm lint', taken)).toBe('pnpm-2')
  })
})

describe('following a rename', () => {
  it('reads a run under the old name back onto the check that runs it', () => {
    const checks = [check('tests-and-coverage', 'pnpm test')]
    const [followed] = followRenames(checks, [run('tests', { ran: 'pnpm test' })])
    expect(followed?.check).toBe('tests-and-coverage')
  })

  it('follows it across a wrapper somebody added or took off', () => {
    const checks = [check('tests', 'pnpm exec vitest run')]
    const [followed] = followRenames(checks, [run('suite', { ran: 'vitest run' })])
    expect(followed?.check).toBe('tests')
  })

  it('leaves a run whose check is still there exactly as it is', () => {
    const checks = [check('tests', 'pnpm test'), check('lint', 'pnpm lint')]
    const runs = [run('tests', { ran: 'pnpm lint' })]
    // Its id is a check that exists, so nothing about it is in question — even
    // where the command it recorded now belongs to a different check.
    expect(followRenames(checks, runs)[0]?.check).toBe('tests')
  })

  it('leaves a run alone where two checks run the same command', () => {
    // A relabelling that had to choose would be a guess, and a guess here is
    // a check drawn green off a run of something else.
    const checks = [check('a', 'pnpm test'), check('b', 'pnpm test')]
    const [left] = followRenames(checks, [run('old', { ran: 'pnpm test' })])
    expect(left?.check).toBe('old')
  })

  it('leaves a run that never recorded what it ran', () => {
    // Every run written before `ran` existed. Honest rather than guessed: the
    // record is append-only, so the only cure for this is time.
    const [left] = followRenames([check('tests', 'pnpm test')], [run('old')])
    expect(left?.check).toBe('old')
  })

  it('costs nothing where there is nothing to follow', () => {
    const runs = [run('tests', { ran: 'pnpm test' })]
    expect(followRenames([check('tests', 'pnpm test')], runs)).toEqual(runs)
  })
})
