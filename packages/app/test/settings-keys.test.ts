import { ConfigSchema, type SecretRow, type SettingGroup, settingsOf } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { asPaste } from '../src/input.ts'
import type { PanelOutcome } from '../src/panels/outcome.ts'
import {
  actsOf,
  DONE,
  type SettingsPanel,
  settingsClick,
  settingsKey,
  settingsPanel,
  visibleSettings,
  writeOf,
} from '../src/panels/settings/state.ts'
import { type PanelInputs, panelDismiss } from '../src/panels.ts'

// What a key does to a field on the Settings page — and above all what a
// paste does, since a Sentry DSN is seventy characters and an API key is
// longer, and neither is a thing anybody types.
//
// A terminal wraps a paste in `\x1b[200~ … \x1b[201~` and hands the window one
// string. Every key a field has no meaning for also begins with an escape, so
// a field that reads the escape before it reads the markers throws the whole
// paste away — which is what these fields did, for text, secret and search
// alike.

/** A credential an extension asked for: what the Jev client key is on this page. */
const CLIENT_KEY: SecretRow = {
  path: 'extensions.jev.key',
  title: 'Jev client key',
  means: 'what Jev answers questions with',
  value: '',
  from: null,
}

const GROUPS: SettingGroup[] = settingsOf(
  ConfigSchema.parse({ projects: { checkout: { root: '~/src/checkout' } } }),
  [CLIENT_KEY],
)

const inputs: PanelInputs = { settings: GROUPS, choices: [] }

const settingAt = (path: string) =>
  GROUPS.flatMap((group) => group.settings).find((one) => one.path === path)

/** The panel as it stands with the keyboard on one setting, open for editing or not. */
function on(path: string, over: Partial<SettingsPanel> = {}): SettingsPanel {
  const group = GROUPS.find((one) => one.settings.some((setting) => setting.path === path))
  const panel = settingsPanel(group?.id ?? '')
  const row = visibleSettings(panel, GROUPS).findIndex((setting) => setting.path === path)
  return { ...panel, row, ...over }
}

const editing = (path: string, text = '') => on(path, { editing: { path, text } })

/** The panel a key left behind, which is a settings panel or the test is wrong. */
function after(panel: SettingsPanel, key: string | undefined, data: string): SettingsPanel {
  const out = settingsKey(panel, key, data, inputs)
  if (out.panel?.kind !== 'settings') throw new Error('the panel closed')
  return out.panel
}

const DSN = 'https://0123456789abcdef0123456789abcdef@o447951.ingest.sentry.io/4505'

describe('pasting into a settings field', () => {
  it('takes a bracketed paste whole, however long the value is', () => {
    const panel = after(editing('telemetry.dsn'), undefined, asPaste(DSN))
    expect(panel.editing).toEqual({ path: 'telemetry.dsn', text: DSN })
  })

  it('takes the break at the end of a copied line off, and neither submits nor adds a line', () => {
    const out = settingsKey(editing('telemetry.dsn'), undefined, asPaste(`${DSN}\n`), inputs)
    // Not submitted: the paste is text arriving, and enter is what keeps it.
    expect(out.submit).toBe(false)
    expect(out.choice).toBeUndefined()
    const panel = out.panel?.kind === 'settings' ? out.panel : null
    expect(panel?.editing).toEqual({ path: 'telemetry.dsn', text: DSN })
    expect(panel?.editing?.text).not.toContain('\n')
  })

  it('takes a paste a terminal did not bracket, newline and all', () => {
    // Bracketed paste is a mode a terminal can be in or not: without it a
    // paste arrives as the characters it is, and the rule that used to be
    // here threw away everything holding a control character.
    const panel = after(editing('telemetry.dsn'), undefined, `${DSN}\n`)
    expect(panel.editing?.text).toBe(DSN)
  })

  it('joins a value that was wrapped across two lines into the one line it is', () => {
    const panel = after(
      editing('telemetry.dsn'),
      undefined,
      asPaste('https://key@o1\n  .example/42'),
    )
    expect(panel.editing?.text).toBe('https://key@o1 .example/42')
  })

  it('adds a paste to what is already typed rather than replacing it', () => {
    const panel = after(editing('telemetry.environment', 'my-'), undefined, asPaste('laptop'))
    expect(panel.editing?.text).toBe('my-laptop')
  })

  it('takes one into a credential, which is a field like any other', () => {
    expect(settingAt('extensions.jev.key')?.type.kind).toBe('text')
    const panel = after(editing('extensions.jev.key'), undefined, asPaste('jev_live_9f3c1a\n'))
    expect(panel.editing?.text).toBe('jev_live_9f3c1a')
  })

  it('keeps enter, backspace and escape doing what they did', () => {
    const kept = settingsKey(editing('telemetry.environment', ' box '), 'enter', '\r', inputs)
    expect(kept).toMatchObject({ submit: true, choice: writeOf('telemetry.environment', 'box') })
    expect(after(editing('telemetry.environment', 'box'), 'backspace', '\x7f').editing?.text).toBe(
      'bo',
    )
    expect(after(editing('telemetry.environment', 'box'), 'escape', '\x1b').editing).toBeNull()
  })

  it('leaves a key the field has no meaning for alone', () => {
    const panel = after(editing('telemetry.environment', 'box'), 'f5', '\x1b[15~')
    expect(panel.editing?.text).toBe('box')
  })
})

// The page says "Saved as you change it", and every other control on it keeps
// that promise the moment it is pressed. A field wrote on enter and on nothing
// else, so every other way out of one — Done, the next setting, another
// category, the window behind the page — threw away what had been typed and
// went on saying "Saved" underneath. Pasting a DSN into a masked field was the
// worst of it: nothing on screen said it had gone, so what it looked like was
// a value that resets itself.
describe('leaving a settings field', () => {
  const clicked = (panel: SettingsPanel, control: string) => settingsClick(panel, control, inputs)
  /** The acts one press asks for, in order. */
  const acts = (out: PanelOutcome) => (out.choice === undefined ? [] : actsOf(out.choice))

  it('saves it when the page is closed by its own button', () => {
    const out = clicked(editing('telemetry.dsn', DSN), 'done')
    expect(acts(out)).toEqual([writeOf('telemetry.dsn', DSN), DONE])
    // Not closed here: the page is closed by the act, after the write, so a
    // write that fails leaves it open with the reason on it.
    expect(out.panel?.kind).toBe('settings')
  })

  it('saves it when the click lands on another setting', () => {
    const out = clicked(editing('telemetry.dsn', DSN), 'edit:telemetry.environment')
    expect(acts(out)).toEqual([writeOf('telemetry.dsn', DSN)])
    const panel = out.panel?.kind === 'settings' ? out.panel : null
    expect(panel?.editing).toBeNull()
  })

  it('saves it when the click changes category, and when it lands on nothing', () => {
    for (const control of ['category:voice', 'nothing-in-particular']) {
      const out = clicked(editing('telemetry.dsn', DSN), control)
      expect(acts(out), control).toEqual([writeOf('telemetry.dsn', DSN)])
    }
  })

  it('saves it, and then does what was clicked, when that is a write of its own', () => {
    const out = clicked(editing('telemetry.dsn', DSN), 'toggle:telemetry.errors')
    expect(acts(out)).toEqual([writeOf('telemetry.dsn', DSN), writeOf('telemetry.errors', 'false')])
  })

  it('saves it when the window behind the page is clicked', () => {
    const out = panelDismiss(editing('telemetry.dsn', DSN), inputs)
    expect(acts(out)).toEqual([writeOf('telemetry.dsn', DSN), DONE])
  })

  it('writes nothing when nothing was changed', () => {
    // Sitting on a field and clicking off it is not a save: a live setting
    // would be applied again, and an extension handed its config again, for a
    // value nobody touched.
    const was = settingAt('telemetry.environment')?.value ?? ''
    const out = clicked(editing('telemetry.environment', was), 'done')
    expect(out.submit).toBe(false)
    expect(out.panel).toBeNull()
  })

  it('still throws it away on escape, which is what escape means', () => {
    // A field you can only leave by saving is a field you cannot change your
    // mind about, and escape means "never mind" everywhere else in the window.
    const out = settingsKey(editing('telemetry.dsn', DSN), 'escape', '\x1b', inputs)
    expect(out.submit).toBe(false)
    expect(out.panel?.kind === 'settings' ? out.panel.editing : 'gone').toBeNull()
  })

  it('does not start the field again when you click into the one you are in', () => {
    const out = clicked(editing('telemetry.dsn', DSN), 'edit:telemetry.dsn')
    expect(out.submit).toBe(false)
    expect(out.panel?.kind === 'settings' ? out.panel.editing?.text : null).toBe(DSN)
  })
})

describe('pasting into the other two fields on the page', () => {
  it('goes into the search box', () => {
    const panel = after({ ...on('telemetry.dsn'), focus: 'search' }, undefined, asPaste('sentry\n'))
    expect(panel.search).toBe('sentry')
  })

  it('goes into the query of a list a setting opened', () => {
    const path = 'agents.workspace'
    const panel = after(
      on(path, { dropdown: { path, query: '', index: 0 } }),
      undefined,
      asPaste('worktree'),
    )
    expect(panel.dropdown?.query).toBe('worktree')
  })
})

describe('copying a setting', () => {
  // The keys the file editor copies with, and the order a terminal reports
  // them in as well as the order a person writes them in.
  const KEYS = ['ctrl+shift+c', 'shift+ctrl+c', 'super+c']

  it('asks the window for the value the keyboard is on', () => {
    const groups = settingsOf(
      ConfigSchema.parse({
        projects: { checkout: { root: '~/src/checkout' } },
        telemetry: { environment: 'laptop' },
      }),
      [CLIENT_KEY],
    )
    for (const key of KEYS) {
      const out = settingsKey(on('telemetry.environment'), key, '', { ...inputs, settings: groups })
      expect(out).toMatchObject({ submit: true, choice: 'copy:telemetry.environment' })
    }
  })

  it('asks for what is typed into it while it is open for editing', () => {
    const out = settingsKey(editing('telemetry.environment', 'box'), 'ctrl+shift+c', '', inputs)
    expect(out).toMatchObject({ submit: true, choice: 'copy:telemetry.environment' })
  })

  it('copies a credential, which is a line in a file you can already open', () => {
    // It used to refuse, back when a key was kept where nothing could read it
    // back. Now it is written in `config.yaml` in plain text, so a rule here
    // protected nothing and made moving a key to a second machine a retype.
    const out = settingsKey(
      editing('extensions.jev.key', 'sk_live_copyme'),
      'ctrl+shift+c',
      '',
      inputs,
    )
    expect(out).toMatchObject({ submit: true, choice: 'copy:extensions.jev.key' })
  })

  it('copies a DSN, which is an endpoint and not a key', () => {
    // The one setting that used to be refused here and should not have been.
    // What it grants is the right to send events to one Sentry project — it
    // is published in the JavaScript of every page Sentry watches — and it
    // is seventy characters long, so putting it somewhere it can be read is
    // most of what anybody wants to do with it.
    const dsn = 'https://abc123@o4507.ingest.sentry.io/12345'
    const out = settingsKey(editing('telemetry.dsn', dsn), 'ctrl+shift+c', '', inputs)
    expect(out).toMatchObject({ submit: true, choice: 'copy:telemetry.dsn' })
  })

  it('says a setting is not set rather than copying nothing', () => {
    const out = settingsKey(on('telemetry.environment'), 'ctrl+shift+c', '', {
      ...inputs,
      settings: settingsOf(
        ConfigSchema.parse({
          projects: { checkout: { root: '~/src/checkout' } },
          telemetry: { environment: '' },
        }),
        [CLIENT_KEY],
      ),
    })
    expect(out.submit).toBe(false)
    expect(out.panel?.kind === 'settings' ? out.panel.error : null).toContain('is not set')
  })

  it('is the key being chosen while a key is being chosen', () => {
    const panel = after(
      on('surfaces.voice.talk.key', { capture: { path: 'surfaces.voice.talk.key', key: null } }),
      'ctrl+shift+c',
      '',
    )
    expect(panel.capture?.key).toBe('ctrl+shift+c')
  })
})
