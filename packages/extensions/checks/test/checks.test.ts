import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { checksExtension } from '../src/extension.ts'

// The checks, as an agent and the orchestrator reach them. Real commands in a
// real repository: what is under test is what Tade runs, what it records, and
// what it refuses.

const MANIFEST = [
  'checks:',
  '  - id: hello',
  '    title: Hello',
  '    run: echo hello',
  '  - id: nope',
  '    title: Nope',
  '    run: echo "8 failed" >&2; exit 1',
].join('\n')

function project(manifest = MANIFEST): { root: string; head: string; home: string } {
  const repo = mkrepo()
  mkdirSync(join(repo.root, '.tade'), { recursive: true })
  writeFileSync(join(repo.root, '.tade', 'checks.yaml'), manifest)
  const home = tmp('tade-checks-home-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  demo:\n    root: ${repo.root}\n`)
  return { root: repo.root, head: repo.head(), home }
}

function load(where: { root: string; home: string }) {
  return ExtensionHost.load({
    builtin: [checksExtension],
    config: { extensions: {}, projects: { demo: { root: where.root } } },
    home: where.home,
    env: {},
  })
}

extensionConformance(() => checksExtension, {})

describe('what a project checks', () => {
  it('says what there is and how it stands, without running anything', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('2 checks')
    expect(answer.text).toContain('`hello` has not run at this commit')
    expect(answer.said).toContain('have not run at this commit')
  })

  it('offers to write a manifest for a project that checks nothing', async () => {
    const where = project()
    writeFileSync(join(where.root, '.tade', 'checks.yaml'), 'checks: []\n')
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('.tade/checks.yaml')
  })
})

describe('writing down what a project checks', () => {
  /** A repository with CI and no manifest: the state adoption exists for. */
  function withCi(): { root: string; home: string } {
    const repo = mkrepo()
    mkdirSync(join(repo.root, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(repo.root, '.github', 'workflows', 'ci.yml'),
      [
        'jobs:',
        '  check:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - name: tests',
        '        run: echo testing',
      ].join('\n'),
    )
    const home = tmp('tade-checks-adopt-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  demo:\n    root: ${repo.root}\n`)
    return { root: repo.root, home }
  }

  it('says checks read from CI are not a gate, and offers to adopt them', async () => {
    const where = withCi()
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    // Read, shown, and explicitly not run: the rollup must not read as green.
    expect(answer.text).toContain('none of them run here yet')
    expect(answer.text).toContain('checks_propose')
    expect(answer.text).toContain('**unknown**')
  })

  it('adopts what CI runs, and then those checks are the project’s own', async () => {
    const where = withCi()
    const host = await load(where)
    const wrote = await host.call(
      'checks_propose',
      { adopt: true },
      { caller: { kind: 'orchestrator' } },
    )
    expect(wrote.text).toContain('Wrote .tade/checks.yaml')
    // And what it could not take is named every time, not once.
    expect(wrote.text).toContain('actions/checkout@v4')
    expect(readFileSync(join(where.root, '.tade', 'checks.yaml'), 'utf8')).toContain('echo testing')
    const after = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(after.text).toContain('from .tade/checks.yaml')
    expect(after.text).not.toContain('none of them run here yet')
  })

  it('shows what it would write without writing it', async () => {
    const where = withCi()
    const host = await load(where)
    const answer = await host.call(
      'checks_propose',
      { adopt: true, dry_run: true },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('Would write')
    expect(() => readFileSync(join(where.root, '.tade', 'checks.yaml'), 'utf8')).toThrow()
  })

  it('adds a check to a manifest that is already there', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call(
      'checks_propose',
      { checks: [{ id: 'types', run: 'echo typing', title: 'Types' }] },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('hello, nope, types')
    const after = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(after.text).toContain('3 checks')
  })

  it('refuses a check it cannot write, rather than writing a broken file', async () => {
    const where = project()
    const host = await load(where)
    await expect(
      host.call(
        'checks_propose',
        { checks: [{ id: 'Not An Id', run: 'x' }] },
        { caller: { kind: 'orchestrator' } },
      ),
    ).rejects.toThrow(/not a usable check id/)
    expect(readFileSync(join(where.root, '.tade', 'checks.yaml'), 'utf8')).toBe(MANIFEST)
  })

  it('is not offered to agents, which are judged by these checks', async () => {
    const where = project()
    const host = await load(where)
    await expect(
      host.call(
        'checks_propose',
        { checks: [{ id: 'x', run: 'y' }] },
        { caller: { kind: 'agent', task: 'demo/a', project: 'demo', cwd: where.root } },
      ),
    ).rejects.toThrow(/not offered to agents/)
  })
})

describe('running them', () => {
  it('runs them here, keeps what failed, and writes it down against the commit', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call('checks_run', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('✓ `hello` passed')
    expect(answer.text).toContain('✗ `nope` failed')
    expect(answer.text).toContain('8 failed')
    // And the record is there for the next question, without running again.
    const again = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(again.text).toContain('✗ `nope` failed')
    expect(again.said).toContain('nope failed')
  })

  it('runs only what it was asked for, and says when there is no such check', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call(
      'checks_run',
      { only: ['hello'] },
      { caller: { kind: 'orchestrator' } },
    )
    expect(answer.text).toContain('hello')
    expect(answer.text).not.toContain('nope')
    await expect(
      host.call('checks_run', { only: ['nothing'] }, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/no check called nothing/)
  })

  it('hands back the tail of what a check printed, and says when it never ran', async () => {
    const where = project()
    const host = await load(where)
    await host.call('checks_run', {}, { caller: { kind: 'orchestrator' } })
    const log = await host.call(
      'checks_log',
      { check: 'nope' },
      { caller: { kind: 'orchestrator' } },
    )
    expect(log.text).toContain('8 failed')
    await expect(
      host.call('checks_log', { check: 'never' }, { caller: { kind: 'orchestrator' } }),
    ).rejects.toThrow(/has never run here/)
  })

  it('runs where the agent works, not where the project is', async () => {
    const where = project()
    const other = project()
    const host = await load(where)
    const answer = await host.call(
      'checks_run',
      {},
      { caller: { kind: 'agent', task: 'demo/one', project: 'demo', cwd: other.root } },
    )
    expect(answer.text).toContain(other.head.slice(0, 8))
  })
})

describe('overruling the rule', () => {
  it('is an act with a reason, and says what it covers', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call(
      'checks_override',
      { scope: 'next push', reason: 'the flaky PTY timeout from yesterday' },
      { caller: { kind: 'agent', task: 'demo/one', project: 'demo', cwd: where.root } },
    )
    expect(answer.text).toContain('until the next push')
    expect(answer.text).toContain('flaky PTY timeout')
    expect(answer.text).toContain('stays red')
  })

  it('refuses an agent overruling anything but its own task', async () => {
    const where = project()
    const host = await load(where)
    const caller = { kind: 'agent' as const, task: 'demo/one', project: 'demo', cwd: where.root }
    await expect(
      host.call('checks_override', { scope: 'this project', reason: 'because' }, { caller }),
    ).rejects.toThrow(/its own task/)
    await expect(
      host.call(
        'checks_override',
        { scope: 'this task', task: 'demo/other', reason: 'because' },
        { caller },
      ),
    ).rejects.toThrow(/demo\/other/)
    await expect(
      host.call('checks_override', { scope: 'this task', reason: '  ' }, { caller }),
    ).rejects.toThrow(/say why/)
    await expect(
      host.call('checks_override', { scope: 'this task', reason: 'x', hours: 9 }, { caller }),
    ).rejects.toThrow(/four hours/)
  })
})
