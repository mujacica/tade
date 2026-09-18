import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import type { LaneRecord } from '../src/registry.ts'
import { findTerminal, matchingLines, nextTerminal, terminalsFrom } from '../src/terminals.ts'
import { Workbench } from '../src/workbench.ts'

// Terminals, from the registry's lanes and against real shells.

const lane = (id: string, title: string, over: Partial<LaneRecord> = {}): LaneRecord => ({
  id,
  task: id.split('/').slice(0, 2).join('/'),
  kind: 'terminal',
  spec: { id, cwd: '/src/app', command: 'zsh', args: [] },
  pid: 1,
  startedAt: Number(id.split('/').at(-1)),
  title,
  alive: true,
  exitCode: null,
  lastOutputAt: null,
  ...over,
})

describe('terminals in the registry', () => {
  const lanes = [
    lane('app/terminals/2', 'server'),
    lane('app/terminals/1', 'tests'),
    lane('app/terminals/3', 'old', { alive: false }),
    lane('search/terminals/1', 'terminal 1'),
    lane('app/refunds/agent', 'refunds', { kind: 'agent' }),
  ]

  it('are the live terminal lanes, oldest first, in a project', () => {
    expect(terminalsFrom(lanes, 'app').map((t) => [t.id, t.name])).toEqual([
      ['app/terminals/1', 'tests'],
      ['app/terminals/2', 'server'],
    ])
  })

  it('take the first free number', () => {
    expect(nextTerminal('app', lanes)).toEqual({ id: 'app/terminals/3', name: 'terminal 3' })
  })

  it('are found by name, number or id, and not guessed between', () => {
    const app = terminalsFrom(lanes, 'app')
    expect(findTerminal(app, 'the tests terminal')?.id).toBe('app/terminals/1')
    expect(findTerminal(app, '2')?.name).toBe('server')
    expect(findTerminal(app, 'terminal 1')?.name).toBe('tests')
    expect(findTerminal(app, 'ser')?.name).toBe('server')
    // Two of them and nothing said: which one is a question, not a guess.
    expect(findTerminal(app, null)).toBeNull()
    expect(findTerminal(terminalsFrom(lanes, 'search'), null)?.id).toBe('search/terminals/1')
  })

  it('find lines, any case', () => {
    expect(matchingLines('ok\nTypeError: x\nfine\ntypeerror again', 'typeerror')).toEqual([
      { line: 2, text: 'TypeError: x' },
      { line: 4, text: 'typeerror again' },
    ])
  })
})

describe('a terminal on the workbench', () => {
  let home: string
  let client: Workbench
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-terminals-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('opens in the project, runs a command, is read, searched, renamed and closed', async () => {
    const opened = await client.openTerminal({ project: 'app', cols: 100, rows: 20 })
    expect(opened).toMatchObject({ id: 'app/terminals/1', name: 'terminal 1', cwd: repo.root })

    await client.runInTerminal('terminal 1', 'echo tade-$((40 + 2))')
    await until(async () => (await client.readTerminal('1')).includes('tade-42'))

    const found = await client.searchTerminal('1', 'TADE-42')
    expect(found.matches.some((match) => match.text.includes('tade-42'))).toBe(true)

    await client.renameTerminal('1', 'tests')
    expect(client.terminals('app').map((t) => t.name)).toEqual(['tests'])
    expect(client.terminal('tests').id).toBe('app/terminals/1')

    await client.closeTerminal('tests')
    expect(client.terminals('app')).toEqual([])
  }, 30_000)

  it('types without running when asked, and says which terminal it could not tell apart', async () => {
    await client.openTerminal({ project: 'app', name: 'one' })
    await client.openTerminal({ project: 'app', name: 'two' })
    expect(() => client.terminal('', 'app')).toThrow('which terminal? one, two')
    await client.runInTerminal('two', 'echo typed-only', { submit: false })
    await until(async () => (await client.readTerminal('two')).includes('echo typed-only'))
    expect(await client.readTerminal('two')).not.toContain('\ntyped-only')
  }, 30_000)
})
