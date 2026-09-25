import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import { extensionConformance } from '@tade/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../../test/fixtures/workflow.ts'
import { checksExtension } from '../src/extension.ts'

// The checks, as an agent and the orchestrator reach them. Real commands in a
// real repository: what is under test is what Tade runs, what it records, and
// what it refuses.

const WORKFLOW = ciWorkflow([
  { id: 'hello', run: 'echo hello' },
  { id: 'nope', run: 'echo "8 failed" >&2; exit 1' },
])

function project(workflow = WORKFLOW): { root: string; head: string; home: string } {
  const repo = mkrepo()
  mkdirSync(join(repo.root, '.tade'), { recursive: true })
  mkdirSync(join(repo.root, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo.root, CI_WORKFLOW), workflow)
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

  it('says where they were read from, so nobody looks for a file Tade wrote', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain(`read from ${CI_WORKFLOW}`)
  })

  it('tells a project that says nothing that nothing here will invent a gate', async () => {
    const repo = mkrepo()
    const home = tmp('tade-checks-bare-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  demo:\n    root: ${repo.root}\n`)
    const host = await load({ root: repo.root, home })
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('says nothing about what checking it means')
    // The one line somebody writes for a project like this, and it is not a
    // file in their repository.
    expect(answer.text).toContain('test_command')
    expect(answer.text).toContain('work out what checking it means')
  })
})

describe('reading what a project already says', () => {
  it('does not read a workflow that never says when it runs', async () => {
    // Every rule that keeps this safe hangs off the trigger, so a file with no
    // trigger is one nothing can place — and what is not read is named.
    const where = project(
      ['jobs:', '  check:', '    steps:', '      - name: tests', '        run: echo testing'].join(
        '\n',
      ),
    )
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    expect(answer.text).toContain('says nothing about what checking it means')
    expect(answer.text).toContain('it says nothing about when it runs')
  })

  it('names what only the runner can do, every time rather than once', async () => {
    const where = project()
    const host = await load(where)
    const answer = await host.call('checks_list', {}, { caller: { kind: 'orchestrator' } })
    // A list that quietly holds less than CI does is how a green tick here
    // comes to be read as a green tick there.
    expect(answer.text).toContain('Not read here:')
    expect(answer.text).toContain('actions/checkout@v5')
    expect(answer.text).toContain('prepares the machine rather than checking the code')
  })

  it('offers no way to write a project’s checks down, because there is nothing to write', async () => {
    // An agent judged by these checks never had a tool that rewrote its own
    // gate; now nobody does, because the gate is the project's own CI.
    expect((checksExtension.tools ?? []).map((tool) => tool.name)).not.toContain('checks_propose')
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
