import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type EventInput, loadConfig, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Ui } from '../../src/screen.ts'
import {
  editRecorded,
  recordChange,
  writeApplied,
  writeRecorded,
} from '../../src/wire/config-written.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The config the window writes outside the Settings page — muting, the
// orchestrator's model and thinking, an extension or a server switched, an
// extension's setup, `/settings` and `/project` — written down as
// `config_changed` like a change from the page: what it was, what it is, who
// asked, and never a key. The subjects' own tests drive each through the
// window; this is the door they share, built by hand like `machine.test.ts`.

/** A window over a home of its own, its journal kept here, or refusing every line. */
function wiring(text: string, over: { refuses?: string } = {}) {
  const home = tmp('tade-config-written-')
  const path = join(home, 'config.yaml')
  writeFileSync(path, text)
  const lines: EventInput[] = []
  let state: AppState = initialState()
  const wire = {
    opts: {
      config: ConfigSchema.parse({}),
      home,
      client: {
        log: {
          append: async (line: EventInput) => {
            if (over.refuses) throw new Error(over.refuses)
            lines.push(line)
          },
        },
      },
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => 1_000,
    draw: () => {},
  } as unknown as Wiring
  return { wire, path, lines, said: () => JSON.stringify(state.transcript) }
}

/** The lines a write left, once the ones it began have landed. */
async function changed(lines: EventInput[]): Promise<unknown[]> {
  await new Promise((resolve) => setImmediate(resolve))
  return lines.map((line) => ({ type: line.type, ...line.detail }))
}

describe('the config the window writes outside the Settings page', () => {
  it('writes a key and writes it down, by whoever asked, and nothing for a key left as it was', async () => {
    const { wire, path, lines } = wiring('# mine\norchestrator:\n  thinking: high\n')
    writeRecorded(wire, 'orchestrator.thinking', 'medium')
    writeRecorded(wire, 'orchestrator.model', 'claude-opus-5', 'orchestrator')
    writeRecorded(wire, 'projects.app.root', '/src/app')
    writeRecorded(wire, 'orchestrator.thinking', 'medium')
    expect(readFileSync(path, 'utf8')).toContain('# mine')
    expect(await changed(lines)).toEqual([
      {
        type: 'config_changed',
        path: 'orchestrator.thinking',
        was: 'high',
        now: 'medium',
        by: 'window',
      },
      {
        type: 'config_changed',
        path: 'orchestrator.model',
        was: '',
        now: 'claude-opus-5',
        by: 'orchestrator',
      },
      { type: 'config_changed', path: 'projects.app.root', was: '', now: '/src/app', by: 'window' },
    ])
  })

  it('writes down what an extension took, a key only as being set, and nothing where it was put back', async () => {
    const { wire, path, lines } = wiring('# mine\nextensions:\n  weather:\n    city: Wien\n')
    const before = readFileSync(path, 'utf8')
    await expect(
      writeApplied(wire, [{ key: 'extensions.weather.city', value: 'Atlantis' }], async () => {
        throw new Error('no such city')
      }),
    ).rejects.toThrow('no such city')
    // Put back exactly as it was, comment and all, and no line for a change
    // that did not stand.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(await changed(lines)).toEqual([])

    await writeApplied(
      wire,
      [
        { key: 'extensions.weather.city', value: 'Graz' },
        { key: 'extensions.weather.token', value: 'wk_0123456789', secret: true },
      ],
      async () => {},
    )
    expect(readFileSync(path, 'utf8')).toContain('wk_0123456789')
    expect(await changed(lines)).toEqual([
      {
        type: 'config_changed',
        path: 'extensions.weather.city',
        was: 'Wien',
        now: 'Graz',
        by: 'window',
      },
      {
        type: 'config_changed',
        path: 'extensions.weather.token',
        was: 'not set',
        now: 'set',
        by: 'window',
      },
    ])
    expect(JSON.stringify(lines)).not.toContain('wk_0123456789')
  })

  it('writes down a change made on the shared screen with `/settings`', async () => {
    const { wire, path, lines } = wiring('agents:\n  commit: own-files\n')
    const loaded = await loadConfig(path)
    if (!loaded.ok) throw new Error('the fixture does not load')
    const at = settingsOf(loaded.config)
      .flatMap((group) => group.settings)
      .findIndex((one) => one.path === 'agents.commit')
    // The setting, its first choice, and then nothing more: done.
    const picks = [at, 0]
    const ui = {
      say: () => {},
      context: () => {},
      ask: async (_: string, fallback = '') => fallback,
      confirm: async (_: string, fallback: boolean) => fallback,
      choose: async (_: string, options: readonly string[]) => picks.shift() ?? options.length - 1,
      pause: async () => {},
      run: async () => 0,
    } as Ui
    await editRecorded(wire, ui)
    expect(readFileSync(path, 'utf8')).toContain('commit: when-done')
    expect(await changed(lines)).toEqual([
      {
        type: 'config_changed',
        path: 'agents.commit',
        was: 'own-files',
        now: 'when-done',
        by: 'window',
      },
    ])
  })

  it('says it in the conversation where the journal will not take the line', async () => {
    const { wire, path, said } = wiring('', { refuses: 'the disk is full' })
    writeRecorded(wire, 'surfaces.voice.muted', false)
    // Written all the same: the line is what is missing, and that is what is said.
    expect(readFileSync(path, 'utf8')).toContain('muted: false')
    await new Promise((resolve) => setImmediate(resolve))
    expect(said()).toContain(
      'surfaces.voice.muted is written, but the journal would not take the line that says so (the disk is full), so nothing records what it was before.',
    )
    await recordChange(wire, { path: 'agents.commit', was: '', now: 'never', by: 'window' })
    expect(said()).toContain('agents.commit is written')
  })
})
