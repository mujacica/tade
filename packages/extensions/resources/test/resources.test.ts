import { ExtensionHost } from '@wilco/extensions-core'
import { extensionConformance } from '@wilco/extensions-core/conformance'
import { describe, expect, it } from 'vitest'
import { resourcesExtension } from '../src/extension.ts'
import {
  attribute,
  History,
  type Proc,
  parsePs,
  sampleOf,
  shortCommand,
  sparkline,
  totals,
} from '../src/usage.ts'

// What Wilco costs the machine. Attribution is tested on a process table
// written here; cost is tested on a real one, because the whole point is that
// watching must be cheap on the machine it runs on.

const MB = 1024 ** 2
const table = [
  '    1     0  20000   0.0 /sbin/launchd',
  '  100     1 120000   2.5 node /wilco/packages/cli/src/bin.ts',
  '  101   100 300000  12.0 node /pi/dist/bundle/cli.js --mode rpc --session-dir /h/orchestrator/sessions',
  '  102   100 250000  40.5 node /pi/dist/bundle/cli.js --session-id wilco-shop-refunds -e wilco.ts',
  '  103   102  30000   5.0 /bin/zsh -c pnpm test',
  '  104   103  90000  30.0 node vitest run',
  '  105   100   8000   0.5 /bin/zsh -l',
  '  106   100   4000   0.1 git -C /src/shop status --porcelain=v2',
  '  107   100      0   0.0 pi',
  '  200     1  50000   1.0 /Applications/Other.app/Contents/MacOS/Other',
].join('\n')

const lanes = [
  { id: 'shop/refunds/agent', task: 'shop/refunds', kind: 'agent', pid: 102, alive: true },
  { id: 'shop/terminals/1', task: 'shop/terminals', kind: 'terminal', pid: 105, alive: true },
  { id: 'web/old/agent', task: 'web/old', kind: 'agent', pid: 999, alive: false },
]

const wilco = {
  pid: 100,
  lanes: () => lanes,
  startAgent: async () => ({ task: '', worktree: '' }),
}

extensionConformance(() => resourcesExtension())

describe('whose each process is', () => {
  it('reads what ps prints, in bytes', () => {
    expect(parsePs(table)[1]).toEqual({
      pid: 100,
      ppid: 1,
      rss: 120000 * 1024,
      cpu: 2.5,
      command: 'node /wilco/packages/cli/src/bin.ts',
    })
    expect(parsePs('garbage\n\n  PID  PPID')).toEqual([])
  })

  it('gives an agent everything it started, and tells the orchestrator, the window and helpers apart', () => {
    const groups = attribute(parsePs(table), { window: 100, lanes })
    expect(
      groups.map((group) => [
        group.key,
        group.kind,
        group.project,
        group.processes.map((one) => one.pid),
      ]),
    ).toEqual([
      ['shop/refunds/agent', 'agent', 'shop', [102, 103, 104]],
      ['shop/terminals/1', 'terminal', 'shop', [105]],
      ['window', 'window', null, [100]],
      ['orchestrator', 'orchestrator', null, [101, 107]],
      ['helpers', 'helper', null, [106]],
    ])
    const agent = groups[0]
    expect(agent?.cpu).toBeCloseTo(75.5)
    expect(agent?.rss).toBe(370000 * 1024)
    // Nothing outside Wilco is counted.
    expect(groups.flatMap((group) => group.processes).some((one) => one.pid === 200)).toBe(false)
  })

  it('adds up by project, kind, agent and process', () => {
    const sample = sampleOf(attribute(parsePs(table), { window: 100, lanes }), 0, 12)
    expect(totals(sample, 'project').map((row) => [row.label, row.processes])).toEqual([
      ['shop', 4],
      ['Wilco itself', 4],
    ])
    expect(totals(sample, 'kind')[0]).toMatchObject({ label: 'agents', processes: 3 })
    expect(totals(sample, 'process')[0]?.label).toBe('102 node cli.js (refunds)')
    expect(sample.total.processes).toBe(8)
    expect(shortCommand('/opt/homebrew/bin/node /x/y/bin.ts --flag')).toBe('node bin.ts')
    expect(sparkline([1, 2, 3])).toBe('▁▅█')
  })
})

describe('what it keeps', () => {
  it('is an hour at most, and says the average and peak over a stretch', () => {
    const history = new History(10)
    for (let i = 0; i < 25; i++) {
      history.add({
        at: i * 1000,
        took: 10,
        groups: [],
        total: { cpu: i, rss: i * MB, processes: 1 },
      })
    }
    expect(history.size).toBe(10)
    const summary = history.summary(4_000)
    expect(summary.samples).toBe(5)
    expect(summary.cpu).toEqual({ average: 22, peak: 24 })
  })
})

describe('the extension', () => {
  function host(exec: (command: string) => string, now: () => number) {
    let calls = 0
    const loaded = ExtensionHost.load({
      builtin: [resourcesExtension()],
      config: { extensions: {}, projects: { shop: { root: '/src/shop' } } },
      home: '/nonexistent',
      now,
      exec: async (command) => {
        calls++
        return { code: 0, stdout: exec(command), stderr: '' }
      },
    })
    return { loaded, calls: () => calls }
  }

  it('answers the orchestrator with the breakdown, and never asks ps twice within its interval', async () => {
    let clock = 0
    const { loaded, calls } = host(
      () => table,
      () => clock,
    )
    const extensions = await loaded
    const answer = await extensions.call(
      'resources_usage',
      { by: 'all' },
      { caller: { kind: 'orchestrator' }, wilco },
    )
    expect(answer.text).toContain(
      '**Wilco is using 91% CPU and 783 MB of memory**, across 8 processes.',
    )
    expect(answer.text).toContain('| shop | 76% | 369 MB | 4 |')
    expect(answer.text).toContain('| refunds | 76% | 361 MB | 3 |')
    const [status] = await extensions.statuses(wilco)
    expect(status).toMatchObject({
      extension: 'resources',
      item: { text: '91% · 783 MB', tone: 'quiet' },
      viewable: true,
    })
    expect(calls()).toBe(1)
    clock = 6_000
    await extensions.statuses(wilco)
    expect(calls()).toBe(2)
    expect((await extensions.view('resources', wilco)).markdown).toContain(
      '### The last 15 minutes',
    )
  })

  it('runs when asked out loud, and says the answer in a sentence', async () => {
    const extensions = await ExtensionHost.load({
      builtin: [resourcesExtension()],
      config: { extensions: {}, projects: {} },
      home: '/nonexistent',
      exec: async () => ({ code: 0, stdout: table, stderr: '' }),
    })
    for (const said of [
      'How much memory is Wilco using?',
      'how much CPU is wilco using',
      'how heavy is wilco',
      "what's the resource usage",
      'what is eating my memory',
    ]) {
      expect(extensions.heard(said)?.action.id, said).toBe('usage')
    }
    expect(extensions.heard('use more memory in the cache')).toBeNull()
    const heard = extensions.heard('how much is wilco using')
    const answer = await extensions.call(heard?.action.tool ?? '', heard?.action.input ?? {}, {
      caller: { kind: 'you' },
      wilco,
    })
    expect(answer.said).toBe(
      'Wilco is using 91% CPU and 783 MB of memory; refunds the most, at 76% and 361 MB.',
    )
  })

  it('warns in the status bar above its limits', async () => {
    const extensions = await ExtensionHost.load({
      builtin: [resourcesExtension()],
      config: { extensions: { resources: { warn_cpu: 50 } }, projects: {} },
      home: '/nonexistent',
      exec: async () => ({ code: 0, stdout: table, stderr: '' }),
    })
    const [status] = await extensions.statuses(wilco)
    expect(status?.item.tone).toBe('warning')
  })
})

describe('what watching costs', () => {
  it('attributes a machine of five thousand processes in a few milliseconds', () => {
    const procs: Proc[] = []
    for (let pid = 2; pid < 5_002; pid++) {
      procs.push({
        pid,
        ppid: pid < 100 ? 1 : 2 + (pid % 97),
        rss: 10 * MB,
        cpu: 0.1,
        command: 'node x.js',
      })
    }
    const machine = [{ pid: 1, ppid: 0, rss: MB, cpu: 0, command: 'launchd' }, ...procs]
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p/t${i}/agent`,
      task: `p/t${i}`,
      kind: 'agent',
      pid: 200 + i,
      alive: true,
    }))
    const text = machine
      .map((one) => `${one.pid} ${one.ppid} ${one.rss / 1024} ${one.cpu} ${one.command}`)
      .join('\n')
    const started = performance.now()
    for (let i = 0; i < 10; i++) attribute(parsePs(text), { window: 50, lanes: many })
    const each = (performance.now() - started) / 10
    expect(each).toBeLessThan(50)
  })

  it('reads the real process table in one ps, quickly, and finds this process', async () => {
    const extensions = await ExtensionHost.load({
      builtin: [resourcesExtension()],
      config: { extensions: {}, projects: {} },
      home: '/nonexistent',
    })
    const started = performance.now()
    const answer = await extensions.call(
      'resources_usage',
      { by: 'kind' },
      { caller: { kind: 'you' }, wilco: { ...wilco, pid: process.pid, lanes: () => [] } },
    )
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(answer.text).toContain('the window')
    const took = (answer.data as { took: number }).took
    expect(took).toBeLessThan(1_000)
  })
})
