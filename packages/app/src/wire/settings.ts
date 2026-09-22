import { readFileSync, writeFileSync } from 'node:fs'
import {
  type Config,
  clearedByHarness,
  HARNESS_CHOICES,
  loadConfig,
  parseSetting,
  type SettingGroup,
  settingsOf,
  type ThinkingLevel,
  wantedInstead,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { checkTalkKey } from '../keys.ts'
import {
  actsOf,
  DONE,
  type SettingsPanel,
  settingsPanel,
  UPDATES,
} from '../panels/settings/state.ts'
import { writeSetting } from '../settings.ts'
import {
  type Actions,
  configPathOf,
  type Subject,
  type Submits,
  tilde,
  type Wiring,
  why,
} from './context.ts'

// The Settings page, and the one path a setting is written by.
//
// A setting Tade accepts and ignores is worse than one it does not have, so
// every write here reads the config back and uses what loaded: a value the
// schema refuses is put back as it was, with the reason on the page, rather
// than left in a file Tade will not open next time. A credential goes the
// same way as everything else — it is a setting — and what is said back says
// whether a variable in your shell still wins over what you just typed.

/** What this subject needs from the rest of the window. */
export interface SettingsDeps {
  /** Ask each harness for its accounts again: a sign-in made elsewhere counts. */
  loadAccounts(): void
  /** Read what is installed on this machine, for the Updates page. */
  lookAtWhatIsInstalled(): void
  /** Tell the orchestrator how hard to think; the reason back, if it could not be told. */
  tellThinking(level: ThinkingLevel): Promise<string | null>
  /** An extension has been handed the config again: its setup is read afresh. */
  setupChanged(): void
  /** Muted now: cut off what is being said and drop what was queued behind it. */
  silence(): void
  /** Add, sign into or forget an account, from the Accounts page. */
  accountAction(choice: string): Promise<void>
  /** Install or reload, from the Updates page. */
  updateAction(choice: string): Promise<void>
  /** Three seconds that say whether this terminal may use the microphone. */
  testMicrophone(): Promise<void>
  /** Open a file in your editor: the config, from the button that says where it is. */
  openFile(path: string): Promise<void>
  /** Put a setting's value on the clipboard. Never a credential — `copyHere` refuses those. */
  copy(text: string): Promise<boolean>
  /**
   * Whether this terminal reports key releases, which is what holding a key
   * needs. Both pages here say so rather than promising a key that will not
   * work.
   */
  releases(): boolean
}

export class Settings implements Subject {
  private readonly wire: Wiring
  private readonly deps: SettingsDeps

  constructor(wire: Wiring, deps: SettingsDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * What the page says about itself. The accounts, the models and whether this
   * terminal reports key releases are three other subjects' answers, folded in
   * beside these: the Settings page is the one place in the window that is
   * genuinely drawn out of four of them.
   */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind === 'keys') {
      const talk = this.wire.opts.config.surfaces.voice.talk
      return { talkKey: talk.key, talkMode: talk.mode, releases: this.deps.releases() }
    }
    if (panel?.kind !== 'settings') return {}
    return {
      settings: this.rows(),
      lanesSurvive: this.wire.opts.client.driver.capabilities.detach,
      configPath: tilde(this.path),
      releases: this.deps.releases(),
      budgetWarnings: 0,
    }
  }

  inputs() {
    return { settings: this.rows() }
  }

  actions(): Actions {
    return {
      keys: () => {
        this.wire.put({ ...this.wire.state, panel: { kind: 'keys', busy: false } })
        this.wire.draw()
      },
      settings: async () => {
        await this.open()
      },
      voice: async () => {
        await this.open('voice')
      },
      budgets: async () => {
        await this.open('budgets')
      },
    }
  }

  submits(): Submits {
    return {
      keys: async () => {
        await this.open('shortcuts')
      },
      // One press can be two acts — what leaving a field saves, and then what
      // the click that left it meant — and they are done in the order they
      // were written. A write that fails stops the ones behind it: the page
      // stays open with the reason on it rather than closing over the top of
      // a value that did not save.
      settings: async (panel, choice) => {
        for (const act of choice === undefined ? [] : actsOf(choice)) {
          await this.act(panel, act)
          if (this.wire.state.panel?.kind === 'settings' && this.wire.state.panel.error) return
        }
      },
    }
  }

  /** One of them: a write, the page closing, or whatever else was pressed. */
  private async act(panel: SettingsPanel, choice: string): Promise<void> {
    if (choice === DONE) {
      this.wire.put({ ...this.wire.state, panel: null })
      return
    }
    if (choice.startsWith('write:')) {
      const [path, value] = choice.slice('write:'.length).split('\u0000')
      if (path !== undefined) await this.save(panel, path, value ?? '')
      return
    }
    if (choice === 'open-file') {
      this.wire.put({ ...this.wire.state, panel: null })
      await this.deps.openFile(this.path)
      return
    }
    if (choice.startsWith('copy:')) {
      await this.copied(panel, choice.slice('copy:'.length))
      return
    }
    if (choice.startsWith('account:')) await this.deps.accountAction(choice)
    if (choice.startsWith('updates:')) await this.deps.updateAction(choice)
    if (choice === 'mic-test') await this.deps.testMicrophone()
  }

  /**
   * Every setting Settings shows: what the config holds, and a field for each
   * credential the loaded extensions ask for — so a key can be pasted here as
   * well as on the extension's own page, and is kept in the same one place.
   */
  rows(): SettingGroup[] {
    const secrets = (this.wire.opts.extensions?.secrets() ?? []).map((one) => ({
      path: one.path,
      title: `${one.title} ${one.label.toLowerCase()}`,
      means: one.means,
      value: one.value,
      from: one.from,
      placeholder: one.placeholder,
      variables: one.variables,
    }))
    // What each harness can be told to think at, as it declares it: a level
    // one of them does not have is never offered for it.
    const levels: Record<string, readonly ThinkingLevel[]> = {}
    for (const harness of HARNESS_CHOICES) {
      const can = this.wire.opts.client.capabilitiesOf(harness.id)
      if (can) levels[harness.id] = can.thinkingLevels
    }
    return settingsOf(this.wire.opts.config, secrets, levels)
  }

  /** Where the config is, for the page that says so and the button that opens it. */
  get path(): string {
    return configPathOf(this.wire.opts)
  }

  /** Open the Settings page, on a category. */
  async open(category = 'agents'): Promise<string> {
    this.wire.put({ ...this.wire.state, panel: settingsPanel(category) })
    this.wire.draw()
    // Asked each time the page opens: a sign-in made in another terminal counts.
    this.deps.loadAccounts()
    if (category === UPDATES) this.deps.lookAtWhatIsInstalled()
    return 'Settings are open.'
  }

  /**
   * The config as it is now, everywhere that holds one. The workbench keeps its
   * own copy, and it is the one that decides where agents work, how many may
   * run and what they are told: a setting saved here that only the window saw
   * would say "applies now" and apply to nothing.
   */
  use(config: Config): void {
    const was = this.wire.opts.config.surfaces.voice.muted
    this.wire.opts.config = config
    this.wire.opts.client.config = config
    this.wire.live?.useConfig(config)
    // Muted is quiet now, not at the end of the sentence: the moment you press
    // it is the moment you needed it. What was queued behind goes with it, and
    // the rest of the answer still arriving is not spoken either. Here rather
    // than in the button, so muting from the settings does the same thing.
    if (config.surfaces.voice.muted && !was) this.deps.silence()
  }

  /**
   * Write one setting, read the config back, and use it. A value the schema
   * refuses is put back as it was, with the reason in the panel — never left
   * in a file Tade will not open next time.
   */
  async save(panel: SettingsPanel, path: string, value: string): Promise<void> {
    const rows = this.rows().flatMap((group) => group.settings)
    const setting = rows.find((one) => one.path === path)
    // What choosing this harness clears — read before the write, because
    // after it there is nothing left to read. Only where it actually changes
    // hands: choosing the harness you are already on is not a new choice, and
    // may not quietly take your model away.
    const clearable = (setting?.value ?? '') === value ? [] : clearedByHarness(path)
    const clearing = clearable
      .flatMap((also) => rows.filter((one) => one.path === also))
      .filter((one) => one.value !== '')
      .map((one) => one.title.toLowerCase())
    let before: string | null = null
    try {
      // Read inside the try: a config that cannot be read at all — a
      // directory where the file should be, a permission somebody changed —
      // is a reason on the page, not a throw out of the keyboard handler.
      before = readFileSync(this.path, 'utf8')
      if (setting?.type.kind === 'key') {
        const check = checkTalkKey(value, setting.type.printable === true)
        if (!check.ok) throw new Error(check.reason)
      }
      if (path === 'orchestrator.model') {
        // Chosen as provider/id; stored as the two keys the orchestrator reads.
        const [provider, ...rest] = value.split('/')
        writeSetting(this.path, 'orchestrator.provider', rest.length > 0 ? provider : undefined)
        writeSetting(
          this.path,
          'orchestrator.model',
          rest.length > 0 ? rest.join('/') : value || undefined,
        )
      } else {
        const typed = setting ? parseSetting(setting, value) : value
        if (value !== '' && typed === undefined)
          throw new Error(
            `${setting?.title ?? path} needs ${setting ? wantedInstead(setting) : 'a usable value'}.`,
          )
        writeSetting(this.path, path, typed)
        // Choosing a harness resets what was chosen for the one before it: a
        // model belongs to the harness it was chosen in, and unset is the
        // harness deciding, which is where this sat before anybody chose.
        for (const also of clearable) writeSetting(this.path, also, undefined)
      }
      const loaded = await loadConfig(this.path)
      if (!loaded.ok) {
        if (before !== null) writeFileSync(this.path, before)
        throw new Error(loaded.issues[0]?.message ?? 'the config would not load with that')
      }
      this.use(loaded.config)
      // An extension's own setting means nothing until the extension has it:
      // Settings can change one (which Sentry the Sentry extension reads), so
      // the host is handed the config here as it is from the Extensions panel.
      if (path.startsWith('extensions.')) {
        await this.wire.opts.extensions?.reconfigure(loaded.config.extensions)
        this.deps.setupChanged()
      }
      // How hard the orchestrator thinks is live only if the one running is
      // told: a setting that looks applied and is not is worse than one that
      // waits honestly, so where it could not be told, it says so.
      const trouble =
        path === 'orchestrator.thinking' && loaded.config.orchestrator.thinking
          ? await this.deps.tellThinking(loaded.config.orchestrator.thinking)
          : null
      // A model is chosen per harness, so choosing a harness puts the model
      // back to whatever that harness decides — said, because a choice that
      // disappears without a word reads as a bug.
      const reset =
        clearing.length > 0
          ? ` The ${clearing.join(' and ')} ${clearing.length === 1 ? 'is' : 'are'} cleared: ${value || 'the harness'} decides.`
          : ''
      const told =
        setting?.live === false
          ? `Saved. ${setting.title} applies when Tade next starts.${reset}`
          : trouble
            ? `Saved. It applies when the orchestrator next starts: ${trouble}`
            : `Saved. It applies now.${reset}${this.aboutKey(path, value)}`
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: told, error: null } })
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: null, error: why(err) } })
    }
    this.wire.draw()
  }

  /**
   * A setting's value on the clipboard, said in the panel rather than in the
   * strip under it: the page is over the window, so a notice down there is a
   * notice nobody watching this field can see.
   *
   * A key copies like anything else now. It is in a file you can open, so a
   * rule against copying it out of the window protected nothing and made
   * moving one to a second machine a retype.
   */
  private async copied(panel: SettingsPanel, path: string): Promise<void> {
    const setting = this.rows()
      .flatMap((group) => group.settings)
      .find((one) => one.path === path)
    if (!setting) return
    const value = panel.editing?.path === path ? panel.editing.text : setting.value
    if (value === '') return
    const done = await this.deps.copy(value)
    this.wire.put({
      ...this.wire.state,
      panel: { ...panel, saved: done ? 'Copied.' : null, error: done ? null : 'Could not copy.' },
    })
    this.wire.draw()
  }

  /**
   * What to say about a credential that has just been written: which variable
   * beats it, if one does. A key that is saved and not used is the worst of
   * both, and it is the one thing about a key that cannot be seen on the page.
   */
  private aboutKey(path: string, value: string): string {
    if (!path.startsWith('extensions.') || value.trim() === '') return ''
    const [, extension, ...rest] = path.split('.')
    if (!extension || rest.length === 0) return ''
    const beaten = (() => {
      try {
        return this.wire.opts.extensions?.secretBeatenBy(extension, rest.join('.')) ?? null
      } catch {
        // Not a declared credential after all: nothing to say about it.
        return null
      }
    })()
    return beaten ? ` ${beaten} is set, though, and that is what is used.` : ''
  }
}
