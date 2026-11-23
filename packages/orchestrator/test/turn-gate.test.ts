import { ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { FakeAdapter } from '../../workbench/test/workers-harness.ts'
import { ORCHESTRATOR_RUN, Orchestrator, type TurnGate } from '../src/orchestrator.ts'

// The gate around each turn of its own, where its conversation is one on every
// machine: readied before the prompt is sent, never for a turn already under
// way, closed when the turn is over — and a phone refused, with who is
// answering, rather than kept waiting. Against a scripted harness.

function harness(): FakeAdapter {
  const adapter = new FakeAdapter()
  adapter.capabilities.mcp = true
  adapter.hasConversation = async () => true
  return adapter
}

describe('the gate around a turn of its own', () => {
  const started: Orchestrator[] = []
  afterEach(async () => {
    for (const one of started.splice(0)) await one.stop()
  })

  const start = async (adapter: FakeAdapter) => {
    const runDir = tmp('tade-gate-run-')
    const one = await Orchestrator.start({
      home: tmp('tade-gate-'),
      socket: '/nowhere.sock',
      runDir,
      cwd: runDir,
      config: ConfigSchema.parse({}),
      adapter,
    })
    started.push(one)
    return one
  }

  /** A gate that writes down what was asked of it, in order, with the prompts the harness got. */
  const recording = (adapter: FakeAdapter, refuse?: string) => {
    const log: string[] = []
    const gate: TurnGate = {
      before: async (wait) => {
        log.push(`before ${wait ? 'waiting' : 'not waiting'} (${adapter.prompted.length} sent)`)
        if (refuse && !wait) throw new Error(refuse)
      },
      after: async () => {
        log.push('after')
      },
    }
    return { gate, log }
  }

  it('readies a turn before the prompt is sent, and closes it when the turn is over', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, log } = recording(adapter)
    one.useTurns(gate)
    await one.ask('what word did I say?')
    // A second thing said mid-turn goes into the turn under way: nothing to ready.
    await one.tell('Tade: a task finished')
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(log).toEqual(['before waiting (0 sent)', 'after'])
    expect(adapter.prompted).toHaveLength(2)
  })

  it('puts the gate’s sentence about another machine’s entries above the prompt, and nothing where it has none', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const frames = [
      'Tade: since your last turn on mac, the conversation took in entries written on another machine (2 on vps).',
    ]
    one.useTurns({
      before: async () => {},
      after: async () => {},
      framed: () => frames.shift() ?? null,
    })
    await one.ask('what word did I say?')
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await one.ask('and before that?')
    expect(adapter.prompted.map((p) => p.message)).toEqual([
      'Tade: since your last turn on mac, the conversation took in entries written on another machine (2 on vps).\n\nwhat word did I say?',
      'and before that?',
    ])
  })

  it('refuses a paired device while another machine’s turn holds the conversation, and sends it nothing', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, log } = recording(
      adapter,
      'vps is answering (since 14:02): say it again once it is done',
    )
    one.useTurns(gate)
    await expect(
      one.askFrom('stop the api agent', { how: 'owner', device: 'phone', theirs: true }),
    ).rejects.toThrow('vps is answering (since 14:02)')
    expect(log).toEqual(['before not waiting (0 sent)'])
    expect(adapter.prompted).toHaveLength(0)
    // Nothing is left leased: the next turn from the keyboard is readied as usual.
    expect(one.busy).toBe(false)
  })

  it('reads its record again only between turns, and says why a harness cannot', async () => {
    const adapter = harness()
    const one = await start(adapter)
    expect(one.replica).toBeNull()
    await expect(one.reload()).rejects.toThrow('keeps a conversation of its own on each machine')
    let reloaded = 0
    adapter.capabilities.conversation = { replicate: true }
    ;(adapter as { conversation?: unknown }).conversation = {
      format: {},
      recordFor: async () => '',
      take: async () => {},
      reload: async () => {
        reloaded++
      },
    }
    await one.ask('hello')
    await expect(one.reload()).rejects.toThrow('reads its record again only between turns')
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await one.reload()
    expect(reloaded).toBe(1)
  })
})
