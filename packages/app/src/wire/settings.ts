import { readFileSync, writeFileSync } from 'node:fs'
import {
  type Config,
  clearedByHarness,
  HARNESS_CHOICES,
  LINES_LOOKED_BACK,
  loadConfig,
  namedBy,
  parseSetting,
  type Setting,
  type SettingGroup,
  settingFound,
  settingReach,
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
import { keysPanel } from '../panels/small/state.ts'
import { writeSetting } from '../settings.ts'
import {
  type Actions,
  configPathOf,
  type Subject,
  type Submits,
  saidLately,
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

/** What the orchestrator's settings tools do, answered from this window. */
export interface SettingTools {
  settings(find: string): Promise<string>
  change(req: { path: string; value: string; said: string }): Promise<string>
}

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
  /** The anti-sleep hold is taken or dropped to match what the config now says. */
  holdSleep(): void
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
        this.wire.put({ ...this.wire.state, panel: keysPanel() })
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

  /**
   * What the orchestrator may do with the config, and the boundary it is held
   * to.
   *
   * The boundary is `settingReach` in core, and it is enforced here rather
   * than in the tool: the tool runs inside the model's own process, and a rule
   * that lives where the model lives is a rule the model can be talked out of.
   * It may only ever refuse — everything it allows, the page already allowed.
   */
  tools(): SettingTools {
    return {
      settings: async (find) => this.listed(find),
      change: async (req) => this.asked(req),
    }
  }

  /**
   * Every setting, as something to read: what it is, what it is now, and how
   * far the orchestrator's arm reaches into it.
   *
   * A credential is never read back — it says whether one is set and, where a
   * variable in the shell is what is actually used, which one. Reading a key
   * out loud to whoever is listening is not a thing a tool does, and the page
   * is where somebody checks one against the console that issued it.
   */
  private async listed(find: string): Promise<string> {
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const lines: string[] = []
    for (const group of this.rows()) {
      const found = group.settings.filter(
        (one) => words.length === 0 || settingFound(group, one, words),
      )
      if (found.length === 0) continue
      lines.push(`${group.title} — ${group.about}`)
      for (const setting of found) lines.push(`  ${this.lineFor(group.id, setting)}`)
    }
    if (lines.length === 0) {
      return words.length === 0
        ? 'Tade offers no settings at all, which should not happen.'
        : `Nothing matches ${find}. Ask again with fewer words, or with none for all of them.`
    }
    return lines.join('\n')
  }

  /** One setting on one line: its path, what it is, what it means, how far I reach. */
  private lineFor(group: string, setting: Setting): string {
    const { reach, because } = settingReach(setting.path)
    const shown =
      group === 'credentials'
        ? setting.value === ''
          ? `not set (${setting.fallback})`
          : `set (${setting.fallback})`
        : setting.value === ''
          ? `(${setting.fallback})`
          : setting.value
    const may =
      reach === 'never'
        ? `not mine to change: ${because}`
        : reach === 'asked'
          ? 'only when they ask for it'
          : 'changeable on request'
    return `${setting.path} = ${shown} — ${setting.means} [${may}]`
  }

  /**
   * Change one setting on somebody's behalf, or say why not.
   *
   * Three things have to hold, and each is refused in its own words so the
   * answer says what to do rather than that something went wrong: Tade has to
   * offer the setting at all, the boundary has to reach it, and — for the tier
   * that is most of them — the person has to have asked for *this* setting in
   * their own words.
   *
   * That last check reads the journal, not the argument. `said` is the
   * orchestrator's account of what was asked and is written down beside the
   * change; what *authorises* it is a line the person themselves typed or
   * spoke, because those are kept verbatim and nothing an agent read can ever
   * become one. A page can tell a model to turn the checks off. It cannot put
   * "turn the checks off" in somebody's mouth.
   */
  private async asked(req: { path: string; value: string; said: string }): Promise<string> {
    const path = req.path.trim()
    const setting = this.rows()
      .flatMap((group) => group.settings)
      .find((one) => one.path === path)
    if (!setting) {
      throw new Error(
        `Tade has no setting called ${path}. tade_settings lists the ones it offers; the rest of config.yaml is \`tade config\` and a person's own.`,
      )
    }
    const { reach, because } = settingReach(path)
    if (reach === 'never') {
      throw new Error(
        `${setting.title} is not mine to change: ${because}. A person changes it in Settings (ctrl+,) or with \`tade config\` — say that rather than looking for another way.`,
      )
    }
    if (reach === 'asked') {
      if (req.said.trim() === '') {
        throw new Error(
          `${setting.title} is only changed when somebody asks for it. Pass what they said, word for word.`,
        )
      }
      const line = namedBy(setting, await saidLately(this.wire, LINES_LOOKED_BACK))
      if (!line) {
        throw new Error(
          `Nothing they have said names ${setting.title}, so I will not change it. Ask them plainly — "${setting.title.toLowerCase()}" said back to you is enough — or tell them it is Settings (ctrl+,) and \`tade config\`.`,
        )
      }
    }
    return this.write(path, req.value, 'orchestrator', req.said.trim())
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
    // The extensions with them, because a project opened is a project every
    // extension may be asked about and every watch may look at — on the next
    // call and the next look, not after Tade is started again.
    this.wire.opts.extensions?.useProjects(config.projects)
    // Muted is quiet now, not at the end of the sentence: the moment you press
    // it is the moment you needed it. What was queued behind goes with it, and
    // the rest of the answer still arriving is not spoken either. Here rather
    // than in the button, so muting from the settings does the same thing.
    if (config.surfaces.voice.muted && !was) this.deps.silence()
    // And the machine is held awake or let go, for the same reason: here
    // rather than in the button, so the page, the button and a tool changing
    // it on somebody's word all reach the machine the same way.
    this.deps.holdSleep()
  }

  /**
   * Write one setting from the page, and say on it how it went. A value the
   * schema refuses is put back as it was, with the reason in the panel —
   * never left in a file Tade will not open next time.
   */
  async save(panel: SettingsPanel, path: string, value: string): Promise<void> {
    try {
      const told = await this.write(path, value)
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: told, error: null } })
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved: null, error: why(err) } })
    }
    this.wire.draw()
  }

  /**
   * Write a key that has no field on this page, and say nothing on screen
   * about it: which of a project's checks Tade runs here is decided on the page
   * that draws them, and is an ordinary config key underneath.
   *
   * The same door as every field — into the file, read back, handed to
   * everywhere a config is held, and written down as `config_changed`, because
   * a change nobody watched still has to be one somebody can find and undo. A
   * config that would not load is put back exactly as it was, and the reason
   * is thrown to whoever asked.
   *
   * `undefined` takes the key away, which is how a preference stops being one.
   */
  async writeKey(key: string, value: boolean | undefined, was: string): Promise<void> {
    let before: string | null = null
    try {
      before = readFileSync(this.path, 'utf8')
    } catch {
      // No file yet: this write starts one, and there is nothing to put back.
    }
    writeSetting(this.path, key, value)
    const loaded = await loadConfig(this.path)
    if (!loaded.ok) {
      if (before !== null) writeFileSync(this.path, before)
      throw new Error(loaded.issues[0]?.message ?? 'the config would not load with that')
    }
    this.use(loaded.config)
    void this.wire.opts.client.log
      .append({
        type: 'config_changed',
        detail: { path: key, was, now: value === undefined ? '' : String(value), by: 'window' },
      })
      .catch(() => {})
  }

  /**
   * The one path a setting is written by: write it, read the config back, use
   * what loaded, and say what it means for it to have applied.
   *
   * Throws rather than reporting, so every caller says it in its own terms —
   * the page puts it on the field, and a tool hands it to whoever asked. A
   * config that would not load is put back exactly as it was first.
   */
  private async write(
    path: string,
    value: string,
    by: 'window' | 'orchestrator' = 'window',
    said = '',
  ): Promise<string> {
    const groups = this.rows()
    const rows = groups.flatMap((group) => group.settings)
    const setting = rows.find((one) => one.path === path)
    // A key is never in the journal, so what a credential was and is is said
    // as whether there is one. `settingReach` already keeps the orchestrator
    // out of every path one can live at; this is about the page, which can
    // write one, and about the line the page's write leaves behind.
    const held = (text: string) => (this.secret(path) ? (text === '' ? 'not set' : 'set') : text)
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
      // Written down once it is true, with what it was: the config is one file
      // rewritten in place and nothing else remembers, so this line is what
      // makes a change somebody was not at the keyboard for undoable rather
      // than simply different. A refused or failed write changed nothing and
      // has nothing to undo, so nothing is written for one.
      //
      // Not awaited, the way everything the window journals is not: the page
      // closes when the person presses Done, and a journal write between the
      // press and the page going is a page that hangs about for as long as
      // the disk takes.
      void this.wire.opts.client.log
        .append({
          type: 'config_changed',
          detail: {
            path,
            was: held(setting?.value ?? ''),
            now: held(value),
            by,
            ...(said ? { said } : {}),
          },
        })
        .catch(() => {})
      return told
    } catch (err) {
      // Put back as it was, and said as a throw: the page shows it on the
      // field, and a tool hands it to whoever asked for the change.
      throw err instanceof Error ? err : new Error(why(err))
    }
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
   * Whether this setting is a credential — one an extension declared and
   * Settings offers a field for. Asked of the group rather than of the path,
   * because the group *is* the declared list: a key an extension asks for
   * tomorrow is covered the day it asks.
   */
  private secret(path: string): boolean {
    return this.rows().some(
      (group) => group.id === 'credentials' && group.settings.some((one) => one.path === path),
    )
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
