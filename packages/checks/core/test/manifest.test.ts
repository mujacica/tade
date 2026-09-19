import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type inOrder, matches, planFor, readChecks } from '../src/manifest.ts'
import type { RunnerError } from '../src/port.ts'

function project(files: Record<string, string> = {}): { name: string; root: string } {
  const root = tmp('tade-checks-')
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return { name: 'demo', root }
}

describe('what a project says it checks', () => {
  it('reads the manifest a project commits', async () => {
    const manifest = await readChecks(
      project({
        '.tade/checks.yaml': [
          'checks:',
          '  - id: format',
          '    title: Formatting and lint',
          '    run: pnpm exec biome ci .',
          '    minutes: 3',
          '  - id: tests',
          '    title: Tests',
          '    run: pnpm exec vitest run',
          '    alone: true',
          'ci:',
          '  runs_on: [ubuntu-latest, macos-latest]',
          "  node: '22'",
          '  setup:',
          '    - uses: actions/checkout@v4',
        ].join('\n'),
      }),
    )
    expect(manifest.source).toBe('manifest')
    expect(manifest.checks.map((one) => one.id)).toEqual(['format', 'tests'])
    expect(manifest.checks[0]?.minutes).toBe(3)
    expect(manifest.checks[0]?.required).toBe(true)
    expect(manifest.checks[1]?.alone).toBe(true)
    expect(manifest.ci.runs_on).toEqual(['ubuntu-latest', 'macos-latest'])
    expect(manifest.ci.node).toBe('22')
    expect(manifest.ci.setup).toEqual([{ uses: 'actions/checkout@v4' }])
    expect(manifest.problems).toEqual([])
  })

  it('says what is wrong with a manifest rather than throwing over it', async () => {
    const manifest = await readChecks(
      project({
        '.tade/checks.yaml': [
          'checks:',
          '  - id: Format',
          '    run: x',
          '  - id: types',
          '    title: Types',
          '  - id: tests',
          '    run: pnpm test',
          '    needs: [nothing]',
        ].join('\n'),
      }),
    )
    expect(manifest.checks.map((one) => one.id)).toEqual(['tests'])
    expect(manifest.problems.join(' ')).toContain('no usable id')
    expect(manifest.problems.join(' ')).toContain('types has no command')
    expect(manifest.problems.join(' ')).toContain('needs nothing')
  })

  it('reads the workflows best-effort when there is no manifest, and says it is a guess', async () => {
    const manifest = await readChecks(
      project({
        '.github/workflows/ci.yml': [
          'jobs:',
          '  check:',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - name: types',
          '        run: pnpm typecheck',
          '      - name: matrixed',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow's own syntax
          '        run: pnpm test --shard ${{ matrix.shard }}',
        ].join('\n'),
      }),
    )
    expect(manifest.source).toBe('workflows')
    expect(manifest.checks.map((one) => one.id)).toEqual(['types', 'matrixed'])
    // What the runner cannot reproduce is named and skipped, never a tick.
    expect(manifest.checks[1]?.skip).toContain('needs CI')
    expect(manifest.problems.join(' ')).toContain('.tade/checks.yaml')
  })

  it('falls back to the one test command, and to nothing at all', async () => {
    const one = await readChecks({ ...project(), test: 'pnpm test' })
    expect(one.source).toBe('test command')
    expect(one.checks).toHaveLength(1)
    expect(one.checks[0]?.run).toBe('pnpm test')
    const none = await readChecks(project())
    expect(none.source).toBe('none')
    expect(none.checks).toEqual([])
  })
})

describe('what would run for a commit', () => {
  const check = (id: string, extra: Partial<Parameters<typeof inOrder>[0][number]> = {}) => ({
    id,
    title: id,
    run: 'true',
    alone: false,
    minutes: 1,
    required: true,
    ...extra,
  })

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
    expect(planFor(docs)).toHaveLength(1)
  })

  it('runs only what was asked for, and says so when that is nothing it has', () => {
    const all = [check('format'), check('tests')]
    expect(planFor(all, { only: ['tests'] }).map((one) => one.id)).toEqual(['tests'])
    expect(() => planFor(all, { only: ['nope'] })).toThrow(/no check called nope/)
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
