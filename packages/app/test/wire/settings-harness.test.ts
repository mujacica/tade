import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Settings } from '../../src/wire/settings.ts'

// Changing a harness, and the two things that have to happen with it.
//
// Built by hand rather than through the window harness: what is under test is
// what one write does — which keys it clears, and who it tells — and a real
// window would answer that with a real workbench and three harnesses behind
// it. `settings.test.ts` is where a keystroke reaches this subject.

function world() {
  const home = tmp('tade-harness-')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.yaml'), 'orchestrator:\n  harness: pi\n  model: kimi-k2.6\n')
  const asked: string[] = []
  let state: AppState = initialState()
  const wire = {
    opts: {
      home,
      config: ConfigSchema.parse({
        orchestrator: { harness: 'pi', model: 'kimi-k2.6' },
      }),
      client: {
        config: null as unknown,
        capabilitiesOf: () => null,
        // Every change is written down as `config_changed`, which is what
        // makes one findable and undoable; the test only has to not swallow it.
        log: { append: async () => {} },
      },
      extensions: null,
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: null,
    now: () => 1_000,
    openedAt: 0,
    draw: () => {},
    journal: null,
    note: () => {},
  } as unknown as Wiring
  const settings = new Settings(wire, {
    loadAccounts: () => {},
    refreshModels: async () => void asked.push('refreshModels'),
    lookAtWhatIsInstalled: () => {},
    tellThinking: async () => null,
    setupChanged: () => {},
    silence: () => {},
    holdSleep: () => {},
  } as never)
  return { settings, asked, config: () => readFileSync(join(home, 'config.yaml'), 'utf8') }
}

describe('changing which harness the orchestrator talks through', () => {
  it('takes the model with it, and asks the new harness what it runs', async () => {
    const it_ = world()
    await it_.settings.write('orchestrator.harness', 'claude-code')
    const written = it_.config()
    expect(written).toContain('harness: claude-code')
    // A model belongs to the harness it was chosen in — pi's `kimi-k2.6` is a
    // name Claude Code never heard of — so it goes, and unset is the harness
    // deciding, which is where the setting sits before anybody chooses.
    expect(written).not.toContain('kimi-k2.6')
    // And the new harness has never been asked what it runs, which is the next
    // thing somebody opens: unasked, its model picker opened empty under a row
    // still offering the three harness names, which is what "the model
    // dropdown offers pi, claude, codex" was.
    expect(it_.asked).toEqual(['refreshModels'])
  })

  it('asks nobody when the harness did not actually change', async () => {
    // Choosing the harness you are already on is not a new choice, and may
    // not quietly take your model away either.
    const it_ = world()
    await it_.settings.write('orchestrator.harness', 'pi')
    expect(it_.config()).toContain('kimi-k2.6')
    expect(it_.asked).toEqual([])
  })

  it('asks nobody for a setting that is not a harness', async () => {
    const it_ = world()
    await it_.settings.write('orchestrator.reflect', 'false')
    expect(it_.config()).toContain('kimi-k2.6')
    expect(it_.asked).toEqual([])
  })
})
