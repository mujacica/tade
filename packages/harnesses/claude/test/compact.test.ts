import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { COMPACT_LINE, compactionIn, percentOf, tokensIn, windowIn } from '../src/compact.ts'

// How full the conversation Tade draws itself is, and how it is made shorter
// without losing it. The lines a fake `claude` says below are the ones a real
// 2.1.287 said, sent `/compact` over `-p --input-format stream-json`: the
// same session id before and after, and what is left in `compact_boundary`.

describe('what the protocol says about the context', () => {
  it('counts what a request was sent, cached or not, and not what it wrote back', () => {
    const usage = {
      input_tokens: 10,
      cache_creation_input_tokens: 9_920,
      cache_read_input_tokens: 13_803,
      output_tokens: 6,
    }
    expect(tokensIn({ usage })).toBe(23_733)
    expect(tokensIn({})).toBeNull()
  })

  it('takes the window of the model it is on, and the largest where that is not named', () => {
    const result = {
      modelUsage: {
        'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
        'claude-opus-5[1m]': { contextWindow: 1_000_000 },
      },
    }
    expect(windowIn(result, 'claude-haiku-4-5-20251001')).toBe(200_000)
    expect(windowIn(result, null)).toBe(1_000_000)
    expect(windowIn({}, null)).toBeNull()
  })

  it('is a whole percentage, never past the whole', () => {
    expect(percentOf(160_010, 200_000)).toBe(80)
    expect(percentOf(250_000, 200_000)).toBe(100)
  })

  it('reads a compaction as done with what is left, or failed with why', () => {
    expect(
      compactionIn({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 23_845, post_tokens: 4_197 },
      }),
    ).toEqual({ after: 4_197 })
    expect(
      compactionIn({ type: 'system', subtype: 'status', compact_result: 'success' }),
    ).toBeNull()
    expect(
      compactionIn({
        type: 'system',
        subtype: 'status',
        compact_result: 'failed',
        compact_error: 'Not enough messages to compact.',
      }),
    ).toEqual({ failed: 'Not enough messages to compact.' })
    expect(compactionIn({ type: 'system', subtype: 'init' })).toBeNull()
  })

  it('asks for it as the slash command, in a message of its own', () => {
    expect(JSON.parse(COMPACT_LINE)).toEqual({
      type: 'user',
      message: { role: 'user', content: '/compact' },
    })
  })
})

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --system-prompt-snapshot <on|off>     Record the system prompt once per',
]

/**
 * A `claude` that speaks the protocol: a turn fills its context to 80% of a
 * 200k window, and `/compact` leaves 20k — or, while `<bin>.fail` exists,
 * fails the way the status line says one did.
 */
function fakeClaude(help: string[]): string {
  const bin = join(tmp('tade-claude-compact-'), 'claude')
  const say = (event: Record<string, unknown>) => `say(${JSON.stringify(event)})`
  const window = { modelUsage: { 'claude-opus-5': { contextWindow: 200_000 } } }
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      `const help = ${JSON.stringify(help)}`,
      "if (process.argv[2] === '--help') { console.log(help.join('\\n')); process.exit(0) }",
      "const { appendFileSync, existsSync } = require('node:fs')",
      'const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n")',
      "let rest = ''",
      "process.stdin.on('data', (chunk) => {",
      '  rest += chunk',
      "  for (let end = rest.indexOf('\\n'); end >= 0; end = rest.indexOf('\\n')) {",
      '    const message = JSON.parse(rest.slice(0, end)).message',
      '    rest = rest.slice(end + 1)',
      "    if (message.content === '/compact') {",
      "      appendFileSync(process.argv[1] + '.compacts', '/compact\\n')",
      `      ${say({ type: 'system', subtype: 'status', status: 'compacting' })}`,
      `      if (existsSync(process.argv[1] + '.fail')) {`,
      `        ${say({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' })}`,
      `        ${say({ type: 'result', subtype: 'success', result: '', is_error: false, ...window })}`,
      '        continue',
      '      }',
      `      ${say({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })}`,
      `      ${say({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 'same' })}`,
      `      ${say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 160_010, post_tokens: 20_000 } })}`,
      `      ${say({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation…' } })}`,
      `      if (existsSync(process.argv[1] + '.nowindow')) ${say({ type: 'result', subtype: 'success', result: '', is_error: false })}`,
      `      else ${say({ type: 'result', subtype: 'success', result: '', is_error: false, ...window })}`,
      '      continue',
      '    }',
      `    ${say({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 'same' })}`,
      `    ${say({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Refunds has an agent on it.' }], usage: { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 10_000, output_tokens: 12 } } })}`,
      `    ${say({ type: 'result', subtype: 'success', result: 'Refunds has an agent on it.', is_error: false, ...window })}`,
      '  }',
      '})',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('the conversation Tade draws itself, kept short', () => {
  let adapter: ClaudeAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  const run = 'tade/orchestrator/agent'

  const started = async (help = HELP) => {
    const bin = fakeClaude(help)
    adapter = new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: tmp('tade-claude-account-'),
      home: tmp('tade-claude-home-'),
      bin,
      type: async () => {},
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal(run, (signal) => signals.push(signal))
    await adapter.start({
      run,
      task: 'tade/orchestrator',
      cwd: tmp('tade-claude-cwd-'),
      prompt: '',
    })
    return { one: adapter, signals, bin }
  }

  const turn = async (one: ClaudeAdapter, signals: WorkerSignal[]) => {
    const idle = signals.filter((signal) => signal.type === 'idle').length
    await one.prompt(run, 'how is refunds doing?')
    const deadline = Date.now() + 5_000
    while (signals.filter((signal) => signal.type === 'idle').length === idle) {
      if (Date.now() > deadline) throw new Error('the turn never ended')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const fullness = (signals: WorkerSignal[]) =>
    signals.flatMap((signal) => (signal.type === 'context' ? [signal.percent] : []))

  it('says how full it is after every turn, out of the protocol', async () => {
    const { one, signals } = await started()
    await turn(one, signals)
    expect(fullness(signals)).toEqual([80])
  })

  it('compacts between turns, and says how full it is after', async () => {
    const { one, signals } = await started()
    await turn(one, signals)
    await one.compact(run)
    expect(fullness(signals)).toEqual([80, 10])
    // Same conversation: it was never started again.
    expect(signals.filter((signal) => signal.type === 'started')).toHaveLength(1)
  })

  it('compacts once when asked the moment a turn ends, and that turn’s end does not settle it', async () => {
    // What the window does (`Keeping`): a turn ends, its context reads 80%,
    // and the compaction is asked for from inside the `idle` that said so.
    const { one, signals, bin } = await started()
    let compacted: Promise<void> | null = null
    let settledAt: (number | null)[] | null = null
    const off = one.onSignal(run, (signal) => {
      if (signal.type !== 'idle' || compacted) return
      compacted = one.compact(run).then(() => {
        settledAt = fullness(signals)
      })
    })
    await turn(one, signals)
    off()
    expect(compacted).not.toBeNull()
    await compacted
    // Settled by the compaction's own `result`, so how full it is had moved by then.
    expect(settledAt).toEqual([80, 10])
    expect(readFileSync(`${bin}.compacts`, 'utf8')).toBe('/compact\n')
    // The compaction was not a turn: one began and one ended, the one asked.
    const turns = (type: string) => signals.filter((signal) => signal.type === type).length
    expect(turns('turn_started')).toBe(1)
    expect(turns('turn_done')).toBe(1)
    expect(turns('idle')).toBe(1)
    // And what is said next is answered, once.
    await turn(one, signals)
    const said = signals.flatMap((signal) => (signal.type === 'message' ? [signal.text] : []))
    expect(said).toEqual(['Refunds has an agent on it.', 'Refunds has an agent on it.'])
    expect(turns('turn_done')).toBe(2)
    expect(readFileSync(`${bin}.compacts`, 'utf8')).toBe('/compact\n')
  })

  it('keeps the window it last heard of when a compaction’s result does not say one', async () => {
    const { one, signals, bin } = await started()
    await turn(one, signals)
    writeFileSync(`${bin}.nowindow`, '')
    await one.compact(run)
    expect(fullness(signals)).toEqual([80, 10])
  })

  it('says why, in Claude Code’s words, when a compaction fails', async () => {
    const { one, signals, bin } = await started()
    await turn(one, signals)
    writeFileSync(`${bin}.fail`, '')
    await expect(one.compact(run)).rejects.toThrow(
      'Claude Code could not compact: Not enough messages to compact.',
    )
    rmSync(`${bin}.fail`)
    // And the next one is asked like any other.
    await one.compact(run)
    expect(fullness(signals).at(-1)).toBe(10)
  })

  it('pins nothing where the binary takes the option, and says it pins where it does not', async () => {
    const { one } = await started()
    expect(one.capabilities.pins).toBe(false)
    expect(one.capabilities.compact).toBe('idle')
    await one.shutdown()
    const old = await started(HELP.slice(0, 1))
    expect(old.one.capabilities.pins).toBe(true)
    expect(old.one.capabilities.why.pins).toContain('--system-prompt-snapshot')
  })

  it('refuses a run it does not have, rather than writing into nothing', async () => {
    const { one } = await started()
    await expect(one.compact('tade/nobody/agent')).rejects.toThrow('no such run')
  })
})
