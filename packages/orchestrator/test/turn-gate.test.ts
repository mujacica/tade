import { ConfigSchema, LOCAL } from '@tade/core'
import { TurnHeld } from '@tade/harnesses-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { FakeAdapter } from '../../workbench/test/workers-harness.ts'
import { ORCHESTRATOR_RUN, Orchestrator, type TurnGate } from '../src/orchestrator.ts'

// The gate around each turn of its own, where its conversation is one on every
// machine: readied before the prompt is sent, never for a turn already under
// way, closed when the turn is over — and a phone's words taken at once and
// sent after another machine's turn, rather than its request kept waiting.
// Against a scripted harness.

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
  const recording = (adapter: FakeAdapter) => {
    const log: string[] = []
    const gate: TurnGate = {
      before: async (wait) => {
        log.push(`before ${wait ? 'waiting' : 'not waiting'} (${adapter.prompted.length} sent)`)
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

  it('closes the turn it readied for a paired device when the prompt could not be sent', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, log } = recording(adapter)
    one.useTurns(gate)
    adapter.prompt = async () => {
      throw new Error('the harness refused the prompt')
    }
    await expect(
      one.askFrom('stop the api agent', { how: 'owner', device: 'phone', theirs: true }),
    ).rejects.toThrow('the harness refused the prompt')
    // No `idle` will come for a turn that never started, so the lease is let go now.
    expect(log).toEqual(['before not waiting (0 sent)', 'after'])
    expect(one.busy).toBe(false)
    expect(one.arm).toEqual(LOCAL)
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

  /**
   * A gate where another machine's turn holds the lease until `release`: not
   * waiting is `TurnHeld`, waiting resolves once it is let go — or throws
   * `fails` the first time, where one is given. Once it is let go, nothing
   * holds it again.
   */
  const held = (adapter: FakeAdapter, fails?: string) => {
    const log: string[] = []
    let release = () => {}
    let freed = false
    let failed = false
    const free = new Promise<void>((resolve) => {
      release = resolve
    }).then(() => {
      freed = true
    })
    const gate: TurnGate = {
      before: async (wait) => {
        log.push(`before ${wait ? 'waiting' : 'not waiting'} (${adapter.prompted.length} sent)`)
        if (!wait && !freed) throw new TurnHeld('vps is answering (since 14:02)')
        await free
        if (fails && !failed) {
          failed = true
          throw new Error(fails)
        }
      },
      after: async () => {
        log.push('after')
      },
    }
    return { gate, log, release: () => release() }
  }

  const phone = { how: 'owner', device: 'phone', theirs: true } as const

  it('takes a paired device’s words while another machine’s turn holds the conversation, and sends them after it', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, log, release } = held(adapter)
    one.useTurns(gate)
    // Answered at once: the phone's request is not held open for the other turn.
    await one.askFrom('stop the api agent', phone)
    expect(adapter.prompted).toHaveLength(0)
    expect(one.arm).toEqual(LOCAL)
    // A second message meanwhile is taken too, and goes behind the first.
    await one.askFrom('and the web one', phone)
    expect(adapter.prompted).toHaveLength(0)
    release()
    await vi.waitFor(() => expect(adapter.prompted).toHaveLength(1))
    expect(adapter.prompted[0]?.message).toContain('stop the api agent')
    expect(adapter.prompted[0]?.message).not.toContain('and the web one')
    expect(one.arm).toEqual(phone)
    expect(log).toEqual(['before not waiting (0 sent)', 'before waiting (0 sent)'])
    // Never steered into the first one's turn: its own, once that is over.
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await vi.waitFor(() => expect(adapter.prompted).toHaveLength(2))
    expect(adapter.prompted[1]?.message).toContain('and the web one')
    expect(log).toEqual([
      'before not waiting (0 sent)',
      'before waiting (0 sent)',
      'after',
      'before waiting (1 sent)',
    ])
    expect(one.arm).toEqual(phone)
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    expect(one.busy).toBe(false)
    expect(one.arm).toEqual(LOCAL)
  })

  it('takes a paired device’s words while a turn of this machine’s own is running, and sends them as a turn of their own after it', async () => {
    const adapter = harness()
    const one = await start(adapter)
    await one.ask('what is running?')
    expect(one.busy).toBe(true)
    // Answered at once, and nothing reaches the harness mid-turn, where it
    // would be steered into the person's question and under their arm.
    await one.askFrom('stop the api agent', phone)
    await one.askFrom('and the web one', phone)
    expect(adapter.prompted).toHaveLength(1)
    expect(one.arm).toEqual(LOCAL)
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await vi.waitFor(() => expect(adapter.prompted).toHaveLength(2))
    expect(adapter.prompted[1]?.message).toContain('stop the api agent')
    expect(adapter.prompted[1]?.message).not.toContain('and the web one')
    expect(one.arm).toEqual(phone)
    // What is typed here once that turn is over goes after the words still waiting.
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    await one.ask('and now?')
    const words = ['what is running?', 'stop the api agent', 'and the web one', 'and now?']
    expect(
      adapter.prompted.map((p) => words.findIndex((word) => p.message.includes(word))),
    ).toEqual([0, 1, 2, 3])
    expect(one.arm).toEqual(phone)
    adapter.emit(ORCHESTRATOR_RUN, { type: 'idle' })
    expect(one.arm).toEqual(LOCAL)
  })

  it('takes a paired device’s words during a compaction, and sends them once it is over', async () => {
    const adapter = harness()
    const one = await start(adapter)
    let finish = () => {}
    adapter.compact = () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
    const compacting = one.compact()
    await vi.waitFor(() => expect(one.busy).toBe(true))
    await one.askFrom('stop the api agent', phone)
    expect(adapter.prompted).toHaveLength(0)
    finish()
    await compacting
    await vi.waitFor(() => expect(adapter.prompted).toHaveLength(1))
    expect(adapter.prompted[0]?.message).toContain('stop the api agent')
    expect(one.arm).toEqual(phone)
  })

  it('says where the conversation is drawn when the harness goes while a device’s words wait', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const events: string[] = []
    one.onEvent((event) => {
      if (event.type === 'error') events.push(event.reason)
    })
    await one.ask('what is running?')
    await one.askFrom('stop the api agent', phone)
    adapter.emit(ORCHESTRATOR_RUN, { type: 'exited', code: 1 })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toBe(
      'what device phone said waited for the turn before it and could not be sent: The orchestrator is not running: it exited with code 1',
    )
    expect(adapter.prompted).toHaveLength(1)
  })

  it('sends what is typed here meanwhile after the device’s words, never ahead of them', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, release } = held(adapter)
    one.useTurns(gate)
    await one.askFrom('stop the api agent', phone)
    const typed = one.ask('what is running?')
    release()
    await typed
    expect(adapter.prompted.map((p) => p.message.includes('stop the api agent'))).toEqual([
      true,
      false,
    ])
  })

  it('says where the conversation is drawn when the device’s words could not be sent after the other turn', async () => {
    const adapter = harness()
    const one = await start(adapter)
    const { gate, release } = held(adapter, 'the record could not be read again')
    one.useTurns(gate)
    const events: string[] = []
    one.onEvent((event) => {
      if (event.type === 'error') events.push(event.reason)
      else if (event.type === 'idle') events.push('idle')
    })
    await one.askFrom('stop the api agent', phone)
    release()
    await vi.waitFor(() => expect(events).toContain('idle'))
    expect(events).toEqual([
      'what device phone said waited for the turn before it and could not be sent: the record could not be read again',
      'idle',
    ])
    expect(adapter.prompted).toHaveLength(0)
    // Nothing is left waiting or leased: the next turn is readied as usual.
    expect(one.busy).toBe(false)
    expect(one.arm).toEqual(LOCAL)
    await one.ask('what is running?')
    expect(adapter.prompted).toHaveLength(1)
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
