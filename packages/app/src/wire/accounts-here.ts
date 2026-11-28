import {
  HARNESS_CHOICES,
  KEYS_AND_AGENTS,
  machineLabel,
  ownSignInName,
  printable,
  windowLabel,
} from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import {
  type AccountAway,
  type AccountsAnswer,
  type AccountsCall,
  type AccountsTab,
  accountsAnswerOf,
  forwardedCall,
  type WebAccounts,
} from '@tade/web'
import type { AccountView } from '@tade/workbench'
import { takeAccountRequests } from '@tade/workbench/account-requests'
import { withTranscript } from '../model.ts'
import { problem } from '../transcript.ts'
import { type Wiring, why } from './context.ts'
import type { ConversationReach } from './conversation.ts'

// Settings › Accounts for this machine and every one it links to, as this
// window answers it (`@tade/web`'s `accounts.ts`) — for the person's own phone,
// and for another of their machines' window drawing this machine's tab — and
// what a terminal beside this window asked of the accounts (`tade accounts add`
// beside `tade serve`, `account-requests.ts`), done on the beat.
//
// **This machine's**, through the workbench's own acts — the ones the window's
// Accounts page calls — each followed by the config the window holds being
// the one written, and the page read again. **Another machine's**, asked over
// this machine's link to it as its owner (`link.call`), and answered with what
// it said: the far side does it with its own workbench, and nothing of it is
// kept here.
//
// **Written down as the device's**: a `web_did` line for every press, its verb
// and how it went, never a name typed or a key.

/** The far side's door (`@tade/web`'s `routes.ts`). */
const ACCOUNTS_DOOR = '/api/accounts'

/** What the window gives it. */
export interface AccountsHereDeps {
  /** The config the window holds made the one the workbench wrote, as an account action here does. */
  use: () => void
  /** The window's own Accounts page read again; nothing where there is no page. */
  reread: () => void
}

export class AccountsHere implements WebAccounts {
  private readonly wire: Wiring
  private readonly deps: AccountsHereDeps
  private reach: ConversationReach | null = null
  /** One take of the spool at a time: an act can take longer than a beat. */
  private taking = false
  /** What stopped the last take, so a beat that finds it again says nothing. */
  private trouble: string | null = null

  constructor(wire: Wiring, deps: AccountsHereDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** How another machine is reached, once the window's links are made. */
  withReach(reach: ConversationReach): void {
    this.reach = reach
  }

  /** Every machine with a tab: this one first, then each it links to, as the config names them. */
  tabs(): AccountsTab[] {
    return [
      { id: null, label: machineLabel() },
      ...Object.keys(this.wire.opts.config.remotes).map((name) => ({ id: name, label: name })),
    ]
  }

  async carry(call: AccountsCall, device: string): Promise<AccountsAnswer> {
    const machine = call.machine ?? null
    if (machine !== null) {
      return {
        ...(await this.there(machine, call)),
        machine,
        machines: this.tabs(),
        keys: KEYS_AND_AGENTS,
      }
    }
    let said: string | null = null
    let trouble = false
    if (call.do !== 'look') {
      try {
        said = await this.press(call)
        this.record(device, `account ${call.do}`, 'done')
      } catch (err) {
        said = why(err)
        trouble = true
        this.record(device, `account ${call.do}`, 'failed')
      }
    }
    const views = await this.wire.opts.client.accounts().catch((err: unknown) => {
      said = `Its harnesses could not be asked who they are signed in as: ${why(err)}`
      trouble = true
      return null
    })
    return {
      machine: null,
      machines: this.tabs(),
      accounts: views?.map(awayOf) ?? null,
      said,
      trouble,
      keys: KEYS_AND_AGENTS,
    }
  }

  /** One beat: what a terminal asked of the accounts. */
  beat(): void {
    void this.takeRequests()
  }

  /** Do what a terminal spooled since the last beat, and answer it (`account-requests.ts`). */
  async takeRequests(): Promise<void> {
    if (this.taking) return
    this.taking = true
    try {
      const { taken, trouble } = await takeAccountRequests(
        this.wire.opts.home,
        this.wire.opts.client,
        this.wire.now(),
      )
      if (trouble !== null && trouble !== this.trouble) {
        const line = `What a terminal asked of the accounts could not be done here: ${trouble}`
        this.wire.put(
          withTranscript(
            this.wire.state,
            problem(this.wire.state.transcript, line, this.wire.now()),
          ),
        )
        this.wire.draw()
      }
      this.trouble = trouble
      if (taken > 0) this.changed()
    } finally {
      this.taking = false
    }
  }

  /** One press here, with the workbench's own act; what it did, said. Throws why not. */
  private async press(call: Exclude<AccountsCall, { do: 'look' }>): Promise<string> {
    const client = this.wire.opts.client
    try {
      switch (call.do) {
        case 'use': {
          await client.useAccount(call.harness, call.account)
          const who = this.whoOf(call.harness, call.account, 'its own sign-in')
          return `New ${titleOf(call.harness)} agents run as ${who}.`
        }
        case 'sign-out':
          await client.signOut(call.harness, call.account)
          return `${this.whoOf(call.harness, call.account)} is signed out.`
        case 'add': {
          await client.addAccount({ name: call.name, harness: call.harness, kind: call.kind })
          const name = call.name.trim().toLowerCase()
          return call.kind === 'api-key'
            ? `${name} is added: set its key.`
            : `${name} is added: sign it in.`
        }
        case 'remove':
          await client.removeAccount(call.account)
          return `${call.account} is gone, and signed out.`
        case 'name': {
          const named = await client.nameOwnSignIn(
            call.harness,
            call.name === '' ? null : call.name,
          )
          return named === null
            ? `${titleOf(call.harness)}'s own sign-in has no name.`
            : `${titleOf(call.harness)}'s own sign-in is called ${named}.`
        }
        case 'key': {
          const where = await client.saveAccountKey(call.account, call.key)
          return `${call.account}'s key is written in ${where}, beside the account.`
        }
      }
    } finally {
      this.changed()
    }
  }

  /** What an account action wrote, the workbench wrote: the window's config and page follow. */
  private changed(): void {
    this.deps.use()
    this.deps.reread()
  }

  /** What an account is called: its name, its own sign-in's name, or its harness's own sign-in. */
  private whoOf(harness: string, account: string | null, own?: string): string {
    return (
      account ??
      ownSignInName(this.wire.opts.config, harness) ??
      own ??
      `${titleOf(harness)}'s own sign-in`
    )
  }

  /** A look or a press, asked of another machine over this one's link to it. */
  private async there(
    machine: string,
    call: AccountsCall,
  ): Promise<Omit<AccountsAnswer, 'machine' | 'machines' | 'keys'>> {
    const asked = await this.askThere(machine, ACCOUNTS_DOOR, forwardedCall(call))
    if (typeof asked === 'string') return { accounts: null, said: asked, trouble: true }
    const answer = accountsAnswerOf(asked.body)
    if (asked.status !== 200 || answer === null) {
      return { accounts: null, said: answeredBadly(machine, asked), trouble: true }
    }
    return answer
  }

  /** What that machine answered, or why it could not be asked, in words. */
  private async askThere(machine: string, door: string, body: unknown): Promise<Answer | string> {
    if (!(machine in this.wire.opts.config.remotes)) {
      return `No machine called ${printable(machine)} is linked here.`
    }
    const held = this.reach?.(machine) ?? null
    if (held === null) return `${machine} is not linked from this Tade: its link is not open.`
    try {
      return await held.link.call(held.remote, door, body)
    } catch (err) {
      return `${machine} could not be asked: ${why(err)}`
    }
  }

  /** Written down as the device's: that it pressed, and how it went — never a name or a key. */
  private record(device: string, verb: string, state: string): void {
    void this.wire.opts.client.log
      .append({ type: 'web_did', detail: { device, verb, state } })
      .catch((err: unknown) => this.wire.note(new Error(`An account press from away: ${why(err)}`)))
  }
}

/** A harness as people call it. */
function titleOf(harness: string): string {
  return HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
}

/** What a machine answered that is not an answer, said: a Tade there too old, or trouble. */
function answeredBadly(machine: string, asked: Answer): string {
  if (asked.status === 404) {
    return `${machine}'s Tade is older than this one and cannot be asked for its accounts from here: upgrade it from Settings › Remotes.`
  }
  const body = asked.body as { error?: unknown } | null
  const error = typeof body?.error === 'string' ? `: ${body.error.slice(0, 200)}` : ''
  return `${machine} answered ${asked.status}${error}.`
}

/** One account as the page draws it, out of what its harness said. */
export function awayOf(view: AccountView): AccountAway {
  return {
    harness: view.harness,
    title: titleOf(view.harness),
    name: view.name,
    ownName: view.ownName,
    kind: view.kind,
    canAdd: view.canAdd,
    why: view.why,
    signedIn: view.status.signedIn,
    who: view.status.who,
    plan: view.status.plan,
    problem: view.status.problem,
    windows: (view.limits?.windows ?? []).map((one) => ({
      label: windowLabel(one.minutes),
      minutes: one.minutes,
      used: one.used,
    })),
    agents: view.agents,
    forNewAgents: view.forNewAgents,
    projects: [...view.projects],
    canSignIn: view.canSignIn,
    install: view.install
      ? 'command' in view.install
        ? view.install.command
        : view.install.cannot
      : null,
  }
}
