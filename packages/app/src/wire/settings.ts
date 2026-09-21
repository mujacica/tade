import { readFileSync, writeFileSync } from 'node:fs'
import {
  type Config,
  loadConfig,
  parseSetting,
  type Setting,
  type SettingGroup,
  settingsOf,
  type ThinkingLevel,
  wantedInstead,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { checkTalkKey } from '../keys.ts'
import { type SettingsPanel, settingsPanel, UPDATES } from '../panels/settings/state.ts'
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
// than left in a file Tade will not open next time. And a credential never
// goes near the config — it is kept where keys are kept, and what is said
// back says where it went and never the key.

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
      settings: async (panel, choice) => {
        if (choice?.startsWith('write:')) {
          const [path, value] = choice.slice('write:'.length).split('\u0000')
          if (path !== undefined) await this.save(panel, path, value ?? '')
          return
        }
        if (choice === 'open-file') {
          this.wire.put({ ...this.wire.state, panel: null })
          await this.deps.openFile(this.path)
          return
        }
        if (choice?.startsWith('account:')) await this.deps.accountAction(choice)
        if (choice?.startsWith('updates:')) await this.deps.updateAction(choice)
        if (choice === 'mic-test') await this.deps.testMicrophone()
      },
    }
  }

  /**
   * Every setting Settings shows: what the config holds, and a field for each
   * credential the loaded extensions ask for — so a key can be pasted here as
   * well as on the extension's own page, and is kept in the same one place.
   */
  rows(): SettingGroup[] {
    const secrets = (this.wire.opts.extensions?.secrets() ?? []).map((one) => ({
      name: one.name,
      title: `${one.title} ${one.label.toLowerCase()}`,
      means: one.means,
      from: one.from,
      placeholder: one.placeholder,
      variables: one.variables,
    }))
    return settingsOf(this.wire.opts.config, secrets)
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
    const setting = this.rows()
      .flatMap((group) => group.settings)
      .find((one) => one.path === path)
    // A credential never goes near the config, so it never goes near the
    // read-change-write below either: it is kept, and the extension asked
    // again whether it can work now.
    if (setting?.kept) {
      await this.saveKey(panel, setting, value)
      return
    }
    const before = readFileSync(this.path, 'utf8')
    try {
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
      }
      const loaded = await loadConfig(this.path)
      if (!loaded.ok) {
        writeFileSync(this.path, before)
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
      const told =
        setting?.live === false
          ? `Saved. ${setting.title} applies when Tade next starts.`
          : trouble
            ? `Saved. It applies when the orchestrator next starts: ${trouble}`
            : 'Saved. It applies now.'
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: told, error: null } })
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: null, error: why(err) } })
    }
    this.wire.draw()
  }

  /**
   * Keep a key somebody pasted into Settings. It goes where Tade keeps
   * credentials — never the config — and what is said back says where it
   * went, whether the environment still beats it, and never the key.
   */
  private async saveKey(panel: SettingsPanel, setting: Setting, value: string): Promise<void> {
    const kept = setting.kept ?? ''
    const [extension, ...rest] = kept.split('.')
    try {
      const host = this.wire.opts.extensions
      if (!host || !extension || rest.length === 0) throw new Error(`nowhere to keep ${kept}`)
      const saved = host.saveSecret(extension, rest.join('.'), value)
      // Its extension may have been waiting on exactly this to be ready, and
      // where its key is is what the Extensions page says about it.
      await host.reconfigure(this.wire.opts.config.extensions)
      this.deps.setupChanged()
      const told =
        value.trim() === ''
          ? `${setting.title} is cleared.`
          : saved.beaten
            ? `Saved in ${saved.where} — but ${saved.beaten} is set, and that is what is used.`
            : `Saved in ${saved.where}. It applies now.`
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: told, error: null } })
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: null, error: why(err) } })
    }
    this.wire.draw()
  }
}
