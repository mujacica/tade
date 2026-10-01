import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { ConfigSchema, type Setting, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { modelPanel } from '../src/panels/models/state.ts'
import { settingsDropdown } from '../src/panels/settings/control.ts'
import { type Choice, choicesFor, settingsPanel } from '../src/panels/settings/state.ts'
import { COLOUR } from '../src/skin.ts'

// A model picker is one harness's, and says whose.
//
// A model is chosen per harness and never handed across, so every list here
// is the models of the harness it is choosing for — asked of that harness.
// Where it had none to offer there is no list at all, and the harness's own
// sentence stands in its place: another harness's model is a name that fails
// at the next launch, which is the thing this is here to stop.

const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 110,
    height: 30,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    models: [],
    modelsFrom: null,
    modelTarget: 'the orchestrator',
    currentModel: null,
    ...over,
  }) as PanelContext

const drawn = (over: Partial<PanelContext>, query = '') =>
  drawPanel({ ...modelPanel('orchestrator'), query }, context(over)).panel.rows.map((row) =>
    stripTerminalSequences(row),
  )

const setting = (path: string, config: Record<string, unknown> = {}): Setting => {
  const found = settingsOf(ConfigSchema.parse(config))
    .flatMap((group) => group.settings)
    .find((one) => one.path === path)
  if (!found) throw new Error(`no setting called ${path}`)
  return found
}

const choice = (value: string, harness?: string): Choice => ({
  value,
  label: value,
  group: 'anthropic',
  ...(harness ? { harness } : {}),
})

describe('a setting that chooses a model', () => {
  const offered = [
    choice('anthropic/claude-opus-5', 'claude-code'),
    choice('anthropic/claude-sonnet-5', 'claude-code'),
    choice('openrouter/moonshotai/kimi-k2.6', 'pi'),
  ]

  it('offers only what the harness it is for runs', () => {
    // The route runs Claude Code, so pi's kimi is not a choice here: it would
    // be a name Claude Code never heard of.
    const agent = setting('workers.routes.default.model', {
      workers: { routes: { default: { harness: 'claude-code' } } },
    })
    expect(choicesFor(agent, offered).map((one) => one.value)).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-5',
    ])
  })

  it('asks the same question of the orchestrator, which chooses its own', () => {
    const thinker = setting('orchestrator.model', { orchestrator: { harness: 'pi' } })
    expect(choicesFor(thinker, offered).map((one) => one.value)).toEqual([
      'openrouter/moonshotai/kimi-k2.6',
    ])
  })

  it('leaves in a model that came back before anybody asked whose it was', () => {
    const thinker = setting('orchestrator.model', { orchestrator: { harness: 'pi' } })
    expect(choicesFor(thinker, [choice('anthropic/claude-opus-5')])).toHaveLength(1)
  })

  it('offers nothing for a harness nobody has asked, and says which it is', () => {
    // Changing the orchestrator's harness leaves one nothing has been asked
    // about, and a model of another harness is no model at all here — so the
    // list is empty, and the box has to say *why*. "Nothing matches that" was
    // what it said, which sent somebody looking for a model they had typed
    // correctly: the query matched nothing because there was nothing to match.
    const thinker = setting('orchestrator.model', { orchestrator: { harness: 'codex' } })
    expect(choicesFor(thinker, offered)).toEqual([])
    const box = settingsDropdown(
      { ...settingsPanel('orchestrator'), dropdown: { path: thinker.path, query: '', index: 0 } },
      thinker,
      context({ choices: offered }),
    ).rows.map((row) => stripTerminalSequences(row))
    expect(box.join('\n')).toContain('No models from codex yet')

    // And where there *are* models, a query that matches none of them is the
    // query's own answer and still says so.
    const onPi = setting('orchestrator.model', { orchestrator: { harness: 'pi' } })
    const searched = settingsDropdown(
      { ...settingsPanel('orchestrator'), dropdown: { path: onPi.path, query: 'zzz', index: 0 } },
      onPi,
      context({ choices: offered }),
    ).rows.map((row) => stripTerminalSequences(row))
    expect(searched.join('\n')).toContain('Nothing matches that')
  })
})

describe('the model picker', () => {
  const pi = {
    models: [{ id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' }],
    modelsFrom: { harness: 'pi', why: null },
  }

  it('says whose models these are, beside what it is on now', () => {
    const rows = drawn({ ...pi, currentModel: 'kimi-k2.6' }).join('\n')
    expect(rows).toContain('the orchestrator is on kimi-k2.6, in pi')
    expect(rows).toContain('1 of 1 in pi')
  })

  it('says the harness’s own words where it had none to offer, and shows no list', () => {
    const rows = drawn({
      models: [],
      modelsFrom: {
        harness: 'codex',
        why: 'names its own models, and the codex on this machine did not answer',
      },
    }).join('\n')
    expect(rows).toContain('codex names its own models, and the codex on this machine did not')
    // Nothing else's catalog stands in for it.
    expect(rows).not.toContain('moonshotai')
    expect(rows).toContain('0 of 0 in codex')
  })

  it('says it is the harness’s list that has nothing like what was typed', () => {
    // Which is a different thing from a harness that could not say at all.
    const rows = drawn(pi, 'opus').join('\n')
    expect(rows).toContain('No model like that in pi.')
  })
})
