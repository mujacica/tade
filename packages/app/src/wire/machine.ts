import { HARNESS_CHOICES, orchestratorAccount, ownSignInName } from '@tade/core'
import type { AccountAway, AccountsCall, AccountsTab } from '@tade/web'
import type { AccountView } from '@tade/workbench'
import type { Frame } from '../frame.ts'
import {
  ACCOUNTS_HERE,
  type AccountShown,
  accountActions,
  accountMachine,
  accountsTab,
} from '../panels/settings/accounts.ts'
import { ACCOUNTS, settingsPanel } from '../panels/settings/state.ts'
import { promptPanel } from '../panels/small/state.ts'
import type { Ui } from '../screen.ts'
import { talkingTo } from '../talk-tab.ts'
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
  /**
   * Write one setting the way its row on the Settings page does, and say how
   * it went; a value the config refuses is put back and thrown.
   */
  writeSetting(path: string, value: string): Promise<string>
  /** Another machine's orchestrator signed in there, through its link (`Carries.signInOrchestrator`). */
  signInThere(machine: string): Promise<void>
  /** Start this machine's orchestrator again, on what it is signed in as now. */
  restartOrchestrator(): void
  /**
   * Every machine's accounts, and a press on another's carried out there
   * (`AccountsHere`, over this machine's link to it). Absent, the Accounts
   * page is this machine's alone.
   */
  accountsThere?: () => {
    tabs(): AccountsTab[]
    carry(
      call: AccountsCall,
      device: string,
    ): Promise<{ accounts: AccountAway[] | null; said: string | null; trouble: boolean }>
  }
  /** An account's own sign-in on another machine, in a terminal over its link (`Carries`). */
  signInAccountThere?: (machine: string, harness: string, account: string | null) => Promise<void>
}

/** What one other machine's tab holds: what it last said, and whether it is asked again. */
interface Held {
  /** Its accounts as it last said them; null before it has. */
  accounts: AccountShown[] | null
  /** Why it could not say, where the last look could not. */
  said: string | null
  asking: boolean
  /** Asked again the next time its tab is drawn: Settings opened, or something done to it. */
  stale: boolean
}

/** Who presses on another machine's tab, as that machine's door is told: this window. */
const BY = 'window'

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
  /** Each other machine's tab on the Accounts page, by its name (`accounts-here.ts` asks it). */
  private readonly there = new Map<string, Held>()

  constructor(wire: Wiring, deps: MachineDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the Accounts page says, when Settings is open: on the tab it is on. */
  panel(): Frame['panel'] {
    if (this.wire.state.panel?.kind !== 'settings') return {}
    const tabs = this.tabs()
    const tab = this.tab(tabs)
    if (tab === ACCOUNTS_HERE) return { accounts: this.views, accountTabs: tabs }
    const held = this.heldThere(tab)
    return {
      accounts: held?.accounts ?? [],
      accountTabs: tabs,
      accountsSaid: held?.said ?? `Asking ${tab} who its harnesses are signed in as…`,
    }
  }

  inputs() {
    const tabs = this.tabs()
    const tab = this.tab(tabs)
    const views = tab === ACCOUNTS_HERE ? this.views : (this.there.get(tab)?.accounts ?? [])
    return {
      accountActions: accountActions(views, tab === ACCOUNTS_HERE ? null : tab),
      accountTabs: tabs.map((one) => one.id),
    }
  }

  /** The Accounts page's tabs: this machine's, then every machine it links to; none for one machine. */
  private tabs(): { id: string; label: string }[] {
    const tabs = this.deps.accountsThere?.().tabs() ?? []
    if (tabs.length < 2) return []
    return tabs.map((one) => ({ id: one.id ?? ACCOUNTS_HERE, label: one.label }))
  }

  /** The tab the page is on. */
  private tab(tabs: readonly { id: string }[]): string {
    const panel = this.wire.state.panel
    const chosen = panel?.kind === 'settings' ? panel.scope : ACCOUNTS_HERE
    return accountsTab(
      chosen,
      tabs.map((one) => one.id),
    )
  }

  /**
   * What a machine's tab holds, asked for the first time it is drawn and again
   * once it is stale. Never waits: the look answers into the tab and draws.
   */
  private heldThere(machine: string): Held | undefined {
    const held = this.there.get(machine)
    if (held === undefined || (held.stale && !held.asking)) void this.askThere(machine)
    return held
  }

  /**
   * A look or a press on another machine's accounts, over this machine's link
   * to it, and what it answered held for its tab. A press that came back is
   * said on the page; a look that could not look leaves what was said last,
   * with why, rather than an empty tab.
   */
  async askThere(
    machine: string,
    call: AccountsCall = { machine, do: 'look' },
  ): Promise<{ said: string | null; trouble: boolean }> {
    const door = this.deps.accountsThere?.()
    if (door === undefined) return { said: null, trouble: false }
    const was = this.there.get(machine)
    this.there.set(machine, {
      accounts: was?.accounts ?? null,
      said: was?.said ?? null,
      asking: true,
      stale: false,
    })
    const answer = await door.carry(call, BY)
    const accounts = answer.accounts?.map(shownOf) ?? was?.accounts ?? null
    this.there.set(machine, {
      accounts,
      said: answer.accounts === null ? answer.said : null,
      asking: false,
      stale: false,
    })
    this.wire.draw()
    return { said: answer.said, trouble: answer.trouble }
  }

  actions(): Actions {
    return { reload: () => this.deps.reload(), '/login': () => this.logIn() }
  }

  /**
   * `/login` on the orchestrator's line: that orchestrator's harness signed in
   * with its own sign-in, as the account it runs as (`orchestrator.account`),
   * on the machine whose line it was typed on — this one's here, in a terminal
   * over the window, and another machine's on its tab, through its link.
   *
   * The orchestrator's harness runs headless, so its own TUI commands never
   * reach it, and a `/login` handed to it as a sentence is a model asked to
   * sign itself in. Signed in, it starts again so what it runs on is the new
   * sign-in, its conversation carried as on any restart. A harness with
   * nothing to sign in to says why where the line is.
   */
  async logIn(): Promise<void> {
    const there = talkingTo(this.wire.state)
    if (there !== null) {
      await this.deps.signInThere(there)
      return
    }
    const config = this.wire.opts.config
    const harness = config.orchestrator.harness
    const account = orchestratorAccount(config)
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    const who = account ?? ownSignInName(config, harness) ?? `${title}'s own sign-in`
    let code = null as number | null
    try {
      const signing = this.wire.opts.client.signInFor(harness, account)
      await this.deps.onScreenWith(async (ui) => {
        ui.say(`  The orchestrator runs as ${who}. ${signing.how}`)
        code = await ui.run(
          account ?? harness,
          signing.launch.command,
          signing.launch.args,
          signing.launch.env,
        )
      })
    } catch (err) {
      notify(this.wire, `the orchestrator cannot be signed in here: ${why(err)}`)
      this.wire.draw()
      return
    }
    await this.readKeys()
    if (code !== 0) {
      notify(this.wire, `${who}'s sign-in ended before it finished: the orchestrator is as it was`)
      this.wire.draw()
      return
    }
    this.deps.restartOrchestrator()
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
        const [harness = '', kind = 'subscription', machine = ''] = panel.target.split('\u0000')
        const name = text.trim().toLowerCase()
        if (machine !== '') {
          await this.addThere(
            machine,
            harness,
            name,
            kind === 'api-key' ? 'api-key' : 'subscription',
          )
          return
        }
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
      // A label, written through the same door as its row on the Models
      // page (`workers.default_names.<harness>`): empty takes the name away.
      'account-own-name': async (panel, text) => {
        if (!panel.target) return
        const [harness = '', machine = ''] = panel.target.split('\u0000')
        if (machine !== '') {
          await this.pressThere(machine, {
            machine,
            do: 'name',
            harness,
            name: text.trim().toLowerCase(),
          })
          return
        }
        // Nothing to take away is nothing to write: without a name or an
        // added account there is no row, and an empty name is no name.
        const named = this.views.some((one) => one.harness === harness && one.ownName)
        if (text === '' && !named) {
          this.wire.put({ ...this.wire.state, panel: settingsPanel(ACCOUNTS) })
          return
        }
        const told = await this.deps.writeSetting(
          `workers.default_names.${harness}`,
          text.toLowerCase(),
        )
        this.wire.put({
          ...this.wire.state,
          panel: { ...settingsPanel(ACCOUNTS), saved: told },
        })
        await this.loadAccountViews()
      },
      'account-key': async (panel, text) => {
        if (!panel.target) return
        const [account = '', machine = ''] = panel.target.split('\u0000')
        if (machine !== '') {
          await this.pressThere(machine, { machine, do: 'key', account, key: text })
          return
        }
        const where = await this.wire.opts.client.saveAccountKey(panel.target, text)
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

  /**
   * Ask every harness who its accounts are signed in as, and draw what they
   * say — and every other machine's tab asked again the next time it is drawn.
   */
  async loadAccountViews(): Promise<void> {
    for (const held of this.there.values()) held.stale = true
    this.views = await this.wire.opts.client.accounts().catch(() => this.views)
    this.wire.draw()
  }

  /**
   * Do something to an account from the Accounts page: sign it in with its
   * harness's own sign-in, sign it out, have new agents use it, add one, set
   * a key, name a harness's own sign-in, or take one away. Whatever happens is
   * said on the page.
   */
  async accountAction(id: string): Promise<void> {
    const [, verb = '', harness = '', named = ''] = id.split(':')
    const name = named || null
    const machine = accountMachine(id)
    if (machine !== null) {
      await this.actionThere(machine, verb, harness, name)
      return
    }
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    // The own sign-in by the name somebody gave it, where they did.
    const own = this.views.find((one) => one.harness === harness && one.name === null)?.ownName
    try {
      switch (verb) {
        case 'sign-in':
          await this.signInto(harness, name)
          this.onPage(
            `${name ?? own ?? title}: signed in, as far as ${title} says below.`,
            null,
            false,
          )
          break
        case 'sign-out':
          await this.wire.opts.client.signOut(harness, name)
          this.onPage(`${name ?? own ?? title} is signed out.`, null, false)
          break
        case 'use':
          await this.wire.opts.client.useAccount(harness, name)
          this.onPage(
            `New ${title} agents run as ${name ?? own ?? 'its own sign-in'}.`,
            null,
            false,
          )
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
        case 'name':
          this.wire.put({
            ...this.wire.state,
            panel: {
              ...promptPanel('account-own-name', `Name ${title}'s own sign-in`, 'NAME', own ?? ''),
              target: harness,
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

  /**
   * A press on another machine's tab: carried out there, over this machine's
   * link to it — its own sign-in in a terminal there, everything else through
   * its door — and said on the page whatever came of it.
   */
  private async actionThere(
    machine: string,
    verb: string,
    harness: string,
    name: string | null,
  ): Promise<void> {
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    const own = this.there
      .get(machine)
      ?.accounts?.find((one) => one.harness === harness && one.name === null)?.ownName
    switch (verb) {
      case 'sign-in':
        if (this.deps.signInAccountThere === undefined) return
        await this.deps.signInAccountThere(machine, harness, name)
        await this.askThere(machine)
        return
      case 'sign-out':
        await this.pressThere(machine, { machine, do: 'sign-out', harness, account: name })
        return
      case 'use':
        await this.pressThere(machine, { machine, do: 'use', harness, account: name })
        return
      case 'remove':
        if (name) await this.pressThere(machine, { machine, do: 'remove', account: name })
        return
      case 'add':
      case 'add-key':
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel(
              'account-name',
              verb === 'add'
                ? `Add a ${title} account on ${machine}`
                : `Add a ${title} account on ${machine}, paid with an API key`,
              'NAME',
            ),
            target: `${harness}\u0000${verb === 'add' ? 'subscription' : 'api-key'}\u0000${machine}`,
          },
        })
        this.wire.draw()
        return
      case 'name':
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel(
              'account-own-name',
              `Name ${title}'s own sign-in on ${machine}`,
              'NAME',
              own ?? '',
            ),
            target: `${harness}\u0000${machine}`,
          },
        })
        this.wire.draw()
        return
      case 'key':
        if (!name) return
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('account-key', `${name}'s API key on ${machine}`, 'KEY'),
            target: `${name}\u0000${machine}`,
          },
        })
        this.wire.draw()
        return
    }
  }

  /** One press on another machine's accounts, said on its tab of the page. */
  private async pressThere(machine: string, call: AccountsCall): Promise<void> {
    this.backOnTab(machine)
    const came = await this.askThere(machine, call)
    this.onPage(came.trouble ? null : came.said, came.trouble ? came.said : null)
  }

  /**
   * An account added on another machine, and then — for a subscription — its
   * own sign-in there, in a terminal over the link, as one added here goes
   * straight into its sign-in. An API-key account goes straight on to its key.
   */
  private async addThere(
    machine: string,
    harness: string,
    name: string,
    kind: 'subscription' | 'api-key',
  ): Promise<void> {
    this.backOnTab(machine)
    const came = await this.askThere(machine, { machine, do: 'add', harness, name, kind })
    if (came.trouble) {
      this.onPage(null, came.said)
      return
    }
    if (kind === 'api-key') {
      this.wire.put({
        ...this.wire.state,
        panel: {
          ...promptPanel('account-key', `${name}'s API key on ${machine}`, 'KEY'),
          target: `${name}\u0000${machine}`,
        },
      })
      this.wire.draw()
      return
    }
    this.onPage(came.said, null)
    if (this.deps.signInAccountThere === undefined) return
    await this.deps.signInAccountThere(machine, harness, name)
    await this.askThere(machine)
  }

  /** The Accounts page, on that machine's tab: where a prompt over it goes back to. */
  private backOnTab(machine: string): void {
    const panel = this.wire.state.panel
    if (panel?.kind === 'settings' && panel.category === ACCOUNTS && panel.scope === machine) return
    this.wire.put({ ...this.wire.state, panel: settingsPanel(ACCOUNTS, '', machine) })
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

/** Another machine's account as the page draws one of this machine's. */
function shownOf(one: AccountAway): AccountShown {
  return {
    harness: one.harness,
    name: one.name,
    ownName: one.ownName,
    kind: one.kind,
    canAdd: one.canAdd,
    why: one.why,
    status: { signedIn: one.signedIn, who: one.who, plan: one.plan, problem: one.problem },
    limits:
      one.windows.length === 0
        ? null
        : {
            windows: one.windows.map((window) => ({ minutes: window.minutes, used: window.used })),
          },
    agents: one.agents,
    forNewAgents: one.forNewAgents,
    projects: one.projects,
    // Which account the orchestrator there runs as is that machine's setting,
    // moved from its own Settings or by `/login` on its tab.
    forOrchestrator: null,
    canSignIn: one.canSignIn,
    install: one.install === null ? null : { command: one.install },
  }
}
