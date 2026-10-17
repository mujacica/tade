import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConfigSchema } from '@tade/core'
import type { HarnessModels } from '@tade/harnesses-core'
import { taskFilePath } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { AppState, TaskSnapshot } from '../../src/model.ts'
import type { ModelPanel } from '../../src/panels/models/state.ts'
import { emptyTranscript } from '../../src/transcript.ts'
import { Routes } from '../../src/wire/routes.ts'

// What each agent's harness lets a person ask of it, learned as the tasks
// refresh.
//
// A harness is the task file's word, else its project's route in the config, so
// what it offers can only move when one of those does. It was learned again
// for every task on every two-second beat all the same: two YAML files read and
// parsed per agent, to learn what was already known. Counted in beats, never
// over a sleep.

/** What a harness declares it can be asked, as far as the menus read it. */
const capabilities = {
  model: 'live' as const,
  thinking: 'live' as const,
  rename: 'live' as const,
  thinkingLevels: ['low' as const, 'high' as const],
  why: {},
}

function learning() {
  const home = tmp('tade-routes-')
  const task = 'app/refunds'
  const file = taskFilePath(home, task)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'id: app/refunds\nproject: app\n')
  let asked = 0
  let drawn = 0
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({ projects: {} }),
      client: {
        agentHarness: async () => {
          asked++
          return { harness: 'pi', account: null, capabilities }
        },
      },
    },
    live: { worktreeOf: () => '/wt/refunds' },
    draw: () => {
      drawn++
    },
  }
  const routes = new Routes(wire as never, {} as never)
  const tasks = [{ task, state: 'working' }] as TaskSnapshot[]
  return {
    routes,
    wire,
    file,
    asked: () => asked,
    drawn: () => drawn,
    beat: () => routes.learnHarnesses(tasks),
  }
}

describe('what an agent’s harness offers, learned as the tasks refresh', () => {
  it('is read once, and not again on a beat where nothing it is read from moved', async () => {
    const { routes, asked, drawn, beat } = learning()
    await beat()
    expect(asked()).toBe(1)
    expect(drawn()).toBe(1)
    expect(routes.offersFor('app/refunds')?.harness).toBe('pi')
    for (let beats = 0; beats < 10; beats++) await beat()
    expect(asked(), 'the task file was read again for nothing').toBe(1)
    expect(drawn()).toBe(1)
  })

  it('is read again when its task file is written, or the config is', async () => {
    const { wire, file, asked, beat } = learning()
    await beat()
    // What choosing another harness for it writes.
    writeFileSync(file, 'id: app/refunds\nproject: app\nharness: codex\n')
    await beat()
    expect(asked()).toBe(2)
    await beat()
    expect(asked()).toBe(2)
    // Every config written is a new one, routes and all.
    wire.opts.config = ConfigSchema.parse({ projects: {} })
    await beat()
    expect(asked()).toBe(3)
  })
})

/** A model a harness offers, as its catalog names it. */
const offered = (id: string) => ({ id: `openai/${id}`, provider: 'openai', name: id })

/**
 * A picker for the orchestrator, which runs in Codex: what Codex said the last
 * time it was asked, and the orchestrator's own answer, held until `answer`.
 */
function picking(lastSaid: readonly string[], inUse: string | null = null) {
  let answer: (models: HarnessModels) => void = () => {}
  let state = { panel: null, panes: [] } as unknown as AppState
  const wire = {
    opts: {
      config: ConfigSchema.parse({ projects: {}, orchestrator: { harness: 'codex' } }),
      models: async (harness: string) => ({ harness, models: lastSaid.map(offered), why: null }),
      orchestratorModels: () => new Promise<HarnessModels>((resolve) => (answer = resolve)),
    },
    live: null,
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    draw: () => {},
  }
  const routes = new Routes(wire as never, { thinkerModel: () => inUse } as never)
  return {
    routes,
    wire,
    answer: (ids: readonly string[]) =>
      answer({ harness: 'codex', models: ids.map(offered), why: null }),
  }
}

describe('the model picker, opened before its harness has answered', () => {
  it('opens at once on what the harness said last, says it is asking, and fills in', async () => {
    const { routes, wire, answer } = picking(['gpt-5'])
    await routes.refreshModels()
    const opening = routes.openModels('orchestrator')
    // Before Codex has said a word: the panel is there, on the list it gave last.
    expect(wire.state.panel).toMatchObject({ kind: 'model', for: 'orchestrator' })
    expect(routes.panel()).toMatchObject({ modelsFrom: { harness: 'codex', asking: true } })
    expect(routes.offeredModels().map((one) => one.id)).toEqual(['openai/gpt-5'])
    answer(['gpt-5', 'gpt-5.5'])
    await opening
    expect(routes.panel()?.modelsFrom?.asking).toBeUndefined()
    expect(routes.offeredModels().map((one) => one.id)).toEqual(['openai/gpt-5', 'openai/gpt-5.5'])
  })

  it('keeps the keyboard on the model it was on when the answer moves it', async () => {
    const { routes, wire, answer } = picking(['gpt-5', 'gpt-5.5'], 'gpt-5')
    await routes.refreshModels()
    const opening = routes.openModels('orchestrator')
    expect(wire.state.panel).toMatchObject({ index: 0 })
    // Walked to gpt-5.5 while it was asked, and the answer put another above it.
    wire.put({ ...wire.state, panel: { ...(wire.state.panel as ModelPanel), index: 1 } })
    answer(['o4', 'gpt-5', 'gpt-5.5'])
    await opening
    expect(wire.state.panel).toMatchObject({ index: 2 })
  })

  it('leaves alone a picker closed while it was asked', async () => {
    const { routes, wire, answer } = picking(['gpt-5'])
    await routes.refreshModels()
    const opening = routes.openModels('orchestrator')
    wire.put({ ...wire.state, panel: null })
    answer(['gpt-5', 'gpt-5.5'])
    await opening
    expect(wire.state.panel).toBeNull()
  })
})

describe('an agent moved to another model or thinking level, from the window', () => {
  /** A window whose workbench switched the agent, and kept it for new agents or not. */
  function choosing(route: { kept: true; unrecorded?: string } | { kept: false; why: string }) {
    let state = { panel: null, panes: [], transcript: emptyTranscript() } as unknown as AppState
    const wire = {
      opts: {
        home: tmp('tade-routes-'),
        config: ConfigSchema.parse({ projects: {} }),
        client: {
          setAgentModel: async () => ({ provider: 'openai', id: 'gpt-5', route }),
          setAgentThinking: async () => ({ level: 'high', route }),
        },
      },
      live: null,
      get state() {
        return state
      },
      put: (next: AppState) => {
        state = next
      },
      draw: () => {},
      now: () => 0,
    }
    const routes = new Routes(wire as never, { useConfig: () => {} } as never)
    const panel = { kind: 'model', for: 'app/refunds' } as ModelPanel
    return { routes, panel, notice: () => wire.state.notice }
  }

  it('says new agents start on it where it was kept', async () => {
    const { routes, panel, notice } = choosing({ kept: true })
    await routes.chooseModel(panel, 'openai/gpt-5')
    expect(notice()).toBe('app/refunds is switching to gpt-5, and new agents start on it')
    await routes.chooseThinking('app/refunds', 'high')
    expect(notice()).toBe(
      'app/refunds thinks at high from its next turn, and new agents start there',
    )
  })

  it('says a kept route whose journal line was not written beside the switch', async () => {
    const unrecorded =
      'workers.routes.default.model is written, but the journal would not take the line that says so: ENOSPC'
    const { routes, panel, notice } = choosing({ kept: true, unrecorded })
    await routes.chooseModel(panel, 'openai/gpt-5')
    expect(notice()).toBe(
      `app/refunds is switching to gpt-5, and new agents start on it; ${unrecorded}`,
    )
  })

  it('says the agent switched and the route did not, and why, where it was not kept', async () => {
    const why = 'the route could not be written: that would make config.yaml invalid'
    const { routes, panel, notice } = choosing({ kept: false, why })
    await routes.chooseModel(panel, 'openai/gpt-5')
    expect(notice()).toBe(
      `app/refunds is switching to gpt-5, but new agents still start where they did: ${why}`,
    )
    await routes.chooseThinking('app/refunds', 'high')
    expect(notice()).toBe(
      `app/refunds thinks at high from its next turn, but new agents still start where they did: ${why}`,
    )
  })
})
