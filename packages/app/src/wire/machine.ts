import { HARNESS_CHOICES } from '@tade/core'
import type { AccountView } from '@tade/workbench'
import type { Frame } from '../frame.ts'
import { accountActions } from '../panels/settings/accounts.ts'
import { ACCOUNTS, settingsPanel } from '../panels/settings/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import type { Ui } from '../screen.ts'
import { type Actions, notify, type Prompts, type Subject, type Wiring, why } from './context.ts'

// Who Tade runs as — each harness's own accounts, and how each provider is paid
// for — and the terminal a command is run in where somebody can watch it.
//
// What the programs Tade runs are and whether they are current is the Updates
// subject's (`updates.ts`), which runs an update in a terminal opened here.
// Nothing here installs anything: a command is typed into a terminal you are
// looking at, put in front before a key of it is typed.

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

/** How a provider is paid for, the way a page that asked says it. */
function credentialLabel(kind: 'signed-in' | 'api-key' | 'env-key' | undefined): string | null {
  if (kind === 'signed-in') return 'signed in'
  if (kind === 'api-key') return 'API key'
  if (kind === 'env-key') return 'env API key'
  return null
}

export class Machine implements Subject {
  private readonly wire: Wiring
  private readonly deps: MachineDeps
  /**
   * Every account agents can run as, as each harness last said: asked in the
   * background, and again after anything is done to one.
   */
  private views: AccountView[] = []
  /**
   * How each provider is paid for, once read. Null until it has been, which is
   * not the same as none: a warning drawn before anybody looked is a warning
   * about nothing.
   */
  private paid: Record<string, 'signed-in' | 'api-key' | 'env-key'> | null = null

  constructor(wire: Wiring, deps: MachineDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the Accounts page says, when Settings is open. */
  panel(): Frame['panel'] {
    if (this.wire.state.panel?.kind !== 'settings') return {}
    return { accounts: this.views }
  }

  inputs() {
    return { accountActions: accountActions(this.views) }
  }

  actions(): Actions {
    return { reload: () => this.deps.reload() }
  }

  /**
   * An account is added in two steps because the second depends on the first:
   * an API key account goes straight on to its key, and a subscription goes
   * straight into the harness's own sign-in, in a terminal you can see.
   */
  prompts(): Prompts {
    return {
      'account-name': async (panel, text) => {
        if (!panel.target) return
        const [harness = '', kind = 'subscription'] = panel.target.split('\u0000')
        const name = text.trim().toLowerCase()
        await this.wire.opts.client.addAccount({
          name,
          harness,
          kind: kind === 'api-key' ? 'api-key' : 'subscription',
        })
        if (kind === 'api-key') {
          this.wire.put({
            ...this.wire.state,
            panel: { ...promptPanel('account-key', `${name}'s API key`, 'KEY'), target: name },
          })
          return
        }
        this.wire.put({ ...this.wire.state, panel: settingsPanel(ACCOUNTS) })
        await this.signInto(harness, name)
        await this.loadAccountViews()
      },
      'account-key': async (panel, text) => {
        if (!panel.target) return
        const where = this.wire.opts.client.saveAccountKey(panel.target, text)
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...settingsPanel(ACCOUNTS),
            saved: `${panel.target}'s key is written in ${where}, beside the account.`,
          },
        })
        await this.loadAccountViews()
      },
    }
  }

  /** Every account agents can run as, as each harness last said. */
  get accounts(): AccountView[] {
    return this.views
  }

  /**
   * How a provider is paid for, or undefined where there is no credential
   * for it — out of **both** places a credential can be.
   *
   * One of them is a key: an environment variable, or what pi's own sign-in
   * stored, which is what `opts.credentials` reads. The other is **a harness
   * being signed in**, which is a credential for the provider that harness
   * declares it talks to (`AccountView.provider`) and is how a Claude
   * subscription pays for `anthropic` without a key existing anywhere.
   *
   * Only the first was read, so every provider no key covered was drawn as
   * "not signed in" — an orchestrator on a live Claude subscription said it
   * had no account, while agents on the same subscription worked. A key wins
   * where there is one, because that is the order the harness itself asks in.
   */
  paidBy(provider: string): 'signed-in' | 'api-key' | 'env-key' | undefined {
    const key = this.paid?.[provider]
    if (key) return key
    if (this.paid === null) return undefined
    return this.views.some((one) => one.provider === provider && one.status.signedIn)
      ? 'signed-in'
      : undefined
  }

  /** How a provider is paid for, in the words a page that asked says it in. */
  credential(provider: string | null): string | null {
    return provider ? credentialLabel(this.paidBy(provider)) : null
  }

  /**
   * What is wrong with how a provider is paid for, for a surface that has room
   * only for what needs somebody.
   *
   * Nothing at all where a credential was found — that a thing is working is
   * not news — and nothing while none have been read yet, because "not signed
   * in" and "nobody has looked" are two answers and only one of them is worth
   * a person's attention.
   */
  credentialProblem(provider: string | null): string | null {
    if (!provider || this.paid === null) return null
    return this.paidBy(provider) ? null : 'not signed in'
  }

  /**
   * Run a command in a terminal somebody is looking at, rather than behind
   * their back: the same terminal each time, opened if it is not there, and
   * put in front before a key of it is typed.
   */
  async watchCommand(name: string, command: string): Promise<void> {
    try {
      const id = await this.watched(name)
      if (id) await this.wire.opts.client.runInTerminal(id, command)
      else notify(this.wire, `Run it yourself: ${command}`)
    } catch (err) {
      this.wire.note(err)
    }
    this.wire.draw()
  }

  /**
   * The terminal of that name in the project you are in, opened the size of the
   * pane it will be drawn in if it is not there, and put in front. Null where
   * there is no project, and so no folder to open a shell in: what was going
   * to run there is then the caller's to say.
   */
  async watched(name: string): Promise<string | null> {
    const project =
      this.wire.state.project ?? Object.keys(this.wire.opts.config.projects)[0] ?? null
    if (!project) return null
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
    return id
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
    // Only the keys and what they change: whoever asked for this sign-in reads
    // the accounts back itself the moment the terminal closes, and asking
    // every harness who it is twice over is twice the wait for one answer.
    await this.readKeys()
  }

  /**
   * Who each provider is paid by, and what an agent could start on.
   *
   * Both halves of "paid by", because there are two and the answer needs both:
   * the keys (`credentials`), and which harnesses are signed in, which is a
   * credential for the provider each of them declares. Read apart, a sign-in
   * counted for nothing until something else happened to read the accounts —
   * so the strip said "not signed in" about a subscription that was working.
   */
  async loadAccounts(): Promise<void> {
    // Side by side: asking a harness is a program run, and the keys and the
    // accounts have nothing to say to each other. One after the other is that
    // wait twice over, on the one beat this is read — the window's own start.
    const [, views] = await Promise.all([
      this.readKeys(),
      // A look that could not be taken leaves what was read last, as below.
      this.wire.opts.client.accounts().catch(() => this.views),
    ])
    this.views = views
    this.wire.draw()
  }

  /** The keys, and the models a change to them changes. */
  private async readKeys(): Promise<void> {
    // A look that could not be taken is not a look that found nothing: what was
    // read last stands. It used to become an empty answer, which said nothing
    // while nothing was drawn for an absent credential — and now that an absent
    // one is drawn as "not signed in", an empty answer would tell somebody they
    // are signed out of a provider they are talking through.
    //
    // And it is said rather than swallowed. Nothing else in the window notices
    // this failing: the strip draws what the last good read said, so without a
    // line in the strip a machine whose keys have become unreadable looks
    // exactly like one whose keys are fine.
    const read = await this.wire.opts.credentials?.().catch((err: unknown) => {
      this.wire.note(err)
      return null
    })
    this.paid = read ?? this.paid
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
