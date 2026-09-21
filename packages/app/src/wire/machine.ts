import { HARNESS_CHOICES } from '@tade/core'
import type { AccountView } from '@tade/workbench'
import { lookAtUpdates, type UpdateLook } from '@tade/workbench/programs'
import { notice } from '../model.ts'
import { updateActions } from '../panels/settings/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import type { Ui } from '../screen.ts'
import { type Wiring, why } from './context.ts'

// What Tade needs of the machine, and who it runs as: the programs installed
// here, what is current, and each harness's own accounts.
//
// Reading the machine is free and asking the world is not. What is installed
// is read when somebody opens the page; what is *current* reaches the network
// and only when they press the button. Nothing here installs anything — the
// exact command is on the page before it runs, and running it types that
// command into a terminal you are looking at.

/** What this subject needs from the rest of the window. */
export interface MachineDeps {
  /** Start Tade again, the way every reload goes. */
  reload(): void
  /** How big a terminal opened to watch a command should be. */
  terminalSize(): { cols: number; rows: number }
  /** Put a terminal in front, before a key of it is typed. */
  showTerminal(id: string): Promise<void>
  /** Run something on a screen of its own, with the window stopped behind it. */
  onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void>
  /** Read the models an agent can start on again: signing in changes them. */
  refreshModels(): Promise<void>
}

/** How a provider is paid for, the way the status bar says it. */
function credentialLabel(kind: 'signed-in' | 'api-key' | 'env-key' | undefined): string | null {
  if (kind === 'signed-in') return 'signed in'
  if (kind === 'api-key') return 'API key'
  if (kind === 'env-key') return 'env API key'
  return null
}

export class Machine {
  private readonly wire: Wiring
  private readonly deps: MachineDeps
  /**
   * What the Updates page last read: which of the programs Tade runs are
   * here, and — once somebody pressed the button — what is current. Null
   * until the page is opened, because none of it is worth reading before.
   */
  private look: UpdateLook | null = null
  /** A check is going. The only thing on that page that touches the network. */
  private busy = false
  /**
   * Every account agents can run as, as each harness last said: asked in the
   * background, and again after anything is done to one.
   */
  private views: AccountView[] = []
  /** How each provider is paid for, once read. */
  private paid: Record<string, 'signed-in' | 'api-key' | 'env-key'> = {}

  constructor(wire: Wiring, deps: MachineDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the Updates page has read, for the page to draw. */
  get updates(): UpdateLook | null {
    return this.look
  }

  /** Whether a check of what is current is going. */
  get updatesBusy(): boolean {
    return this.busy
  }

  /** Every account agents can run as, as each harness last said. */
  get accounts(): AccountView[] {
    return this.views
  }

  /** How a provider is paid for, or undefined where there is no credential for it. */
  paidBy(provider: string): 'signed-in' | 'api-key' | 'env-key' | undefined {
    return this.paid[provider]
  }

  /** How a provider is paid for, in the words the status bar says it in. */
  credential(provider: string | null): string | null {
    return provider ? credentialLabel(this.paid[provider]) : null
  }

  /**
   * What is installed on this machine, for the Updates page: where each
   * program Tade runs is, how it got there and what it says its version is.
   *
   * Never on a timer and never on the draw path — it runs a `--version` per
   * program, which belongs to somebody opening the page. It touches nothing
   * but this machine; what is *current* is asked separately, and only when
   * the button is pressed.
   */
  async lookAtWhatIsInstalled(): Promise<void> {
    if (this.look || this.busy) return
    this.busy = true
    this.wire.draw()
    try {
      this.look = await lookAtUpdates(this.wire.opts.config, this.wire.opts.home)
    } catch (err) {
      this.wire.note(err)
    } finally {
      this.busy = false
      this.wire.draw()
    }
  }

  /**
   * Do something about updates: ask what is current, run an update in a
   * terminal, or reload.
   *
   * Nothing installs anything here — the exact command is on the page before
   * it is pressed, and pressing it types that command into a terminal you are
   * looking at. Reloading goes the way every reload goes, which asks first
   * when it would stop agents living inside this window.
   */
  async updateAction(id: string): Promise<void> {
    if (id === 'updates:check') {
      if (this.busy) return
      this.busy = true
      this.onPage('Asking what is current…')
      try {
        this.look = await lookAtUpdates(this.wire.opts.config, this.wire.opts.home, { ask: true })
        const behind = this.look.programs.filter((one) => one.behind).length
        const newer = this.look.tade.newer ? 1 : 0
        this.onPage(
          behind + newer === 0
            ? 'Everything Tade could ask about is current.'
            : `${behind + newer} could move forward.`,
        )
      } catch (err) {
        this.onPage(null, why(err))
      } finally {
        this.busy = false
        this.wire.draw()
      }
      return
    }
    if (id === 'updates:reload') {
      this.wire.put({ ...this.wire.state, panel: null })
      this.deps.reload()
      return
    }
    const action = updateActions(this.look, this.busy).find((one) => one.id === id)
    if (!action?.command) return
    await this.watchCommand('updates', action.command)
  }

  /**
   * Run a command in a terminal somebody is looking at, rather than behind
   * their back: the same terminal each time, opened if it is not there, and
   * put in front before a key of it is typed.
   */
  async watchCommand(name: string, command: string): Promise<void> {
    const project =
      this.wire.state.project ?? Object.keys(this.wire.opts.config.projects)[0] ?? null
    if (!project) {
      // No project, no folder to open a shell in. The command is the answer.
      this.wire.put(notice(this.wire.state, `Run it yourself: ${command}`))
      this.wire.draw()
      return
    }
    try {
      let id: string | null = null
      try {
        id = this.wire.opts.client.terminal(name, project).id
      } catch {
        // None open under that name yet.
      }
      if (!id) {
        const size = this.deps.terminalSize()
        const opened = await this.wire.opts.client.openTerminal({
          project,
          name,
          cols: size.cols,
          rows: size.rows,
        })
        id = opened.id
      }
      this.wire.put({ ...this.wire.state, panel: null })
      await this.deps.showTerminal(id)
      await this.wire.opts.client.runInTerminal(id, command)
    } catch (err) {
      this.wire.note(err)
      this.wire.draw()
    }
  }

  /** Ask every harness who its accounts are signed in as, and draw what they say. */
  async loadAccountViews(): Promise<void> {
    this.views = await this.wire.opts.client.accounts().catch(() => this.views)
    this.wire.draw()
  }

  /**
   * Do something to an account from the Accounts page: sign it in with its
   * harness's own sign-in, sign it out, have new agents use it, add one, set
   * a key, or take one away. Whatever happens is said on the page.
   */
  async accountAction(id: string): Promise<void> {
    const [, verb = '', harness = '', named = ''] = id.split(':')
    const name = named || null
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    try {
      switch (verb) {
        case 'sign-in':
          await this.signInto(harness, name)
          this.onPage(`${name ?? title}: signed in, as far as ${title} says below.`, null, false)
          break
        case 'sign-out':
          await this.wire.opts.client.signOut(harness, name)
          this.onPage(`${name ?? title} is signed out.`, null, false)
          break
        case 'use':
          await this.wire.opts.client.useAccount(harness, name)
          this.onPage(`New ${title} agents run as ${name ?? 'its own sign-in'}.`, null, false)
          break
        case 'remove':
          if (name) await this.wire.opts.client.removeAccount(name)
          this.onPage(`${name} is gone, and signed out.`, null, false)
          break
        case 'add':
        case 'add-key':
          this.wire.put({
            ...this.wire.state,
            panel: {
              ...promptPanel(
                'account-name',
                verb === 'add'
                  ? `Add a ${title} account`
                  : `Add a ${title} account paid with an API key`,
                'NAME',
              ),
              target: `${harness}\u0000${verb === 'add' ? 'subscription' : 'api-key'}`,
            },
          })
          this.wire.draw()
          return
        case 'key':
          if (!name) return
          this.wire.put({
            ...this.wire.state,
            panel: { ...promptPanel('account-key', `${name}'s API key`, 'KEY'), target: name },
          })
          this.wire.draw()
          return
      }
    } catch (err) {
      this.onPage(null, why(err), false)
    }
    await this.loadAccountViews()
  }

  /** An account's own sign-in, in a terminal inside this one, then the accounts read again. */
  async signInto(harness: string, name: string | null): Promise<void> {
    const signing = this.wire.opts.client.signInFor(harness, name)
    await this.deps.onScreenWith(async (ui) => {
      ui.say(`  ${signing.how}`)
      await ui.run(name ?? harness, signing.launch.command, signing.launch.args, signing.launch.env)
    })
    await this.loadAccounts()
  }

  /** Who each provider is paid by, and what an agent could start on. */
  async loadAccounts(): Promise<void> {
    this.paid = (await this.wire.opts.credentials?.().catch(() => ({}))) ?? {}
    await this.deps.refreshModels()
    this.wire.draw()
  }

  /**
   * Say on the Settings page what just happened, where it is still open.
   *
   * `drawn` is false where the caller draws once at the end: the account
   * actions each say their line and then read the accounts back, which draws.
   */
  private onPage(saved: string | null, error: string | null = null, drawn = true): void {
    const panel = this.wire.state.panel
    if (panel?.kind === 'settings') {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved, error } })
    }
    if (drawn) this.wire.draw()
  }
}
