import type { PanelOutcome } from '../outcome.ts'
import { stay } from '../outcome.ts'
import type { SettingsPanel } from './state.ts'

// The Accounts page's own: who each harness's agents run as, and what can be
// done about it.
//
// Beside `updates.ts` for the same reason — neither page is a list of values in
// a config file, and `state.ts` is the file every setting's keys and clicks go
// through. What the page *looks* like is `view.ts`, as every other page's is.

/**
 * One thing that can be done on the Accounts page: `account:<verb>:<harness>:<name>`,
 * the name empty for a harness's own sign-in.
 */
export interface AccountAction {
  id: string
  label: string
  danger?: boolean
  /** The harness it is about. */
  harness: string
  /** The account it is about, `null` being its harness's own sign-in; absent for adding one. */
  account?: string | null
}

/** What an account needs from the page: enough to say how it stands and what can be done. */
export interface AccountShown {
  harness: string
  name: string | null
  kind: 'subscription' | 'api-key'
  canAdd: boolean
  why: string | null
  status: { signedIn: boolean; who: string | null; plan: string | null; problem: string | null }
  /** Its plan's windows, shortest first, each by its length. */
  limits: { windows: readonly { minutes: number; used: number }[] } | null
  agents: number
  forNewAgents: boolean
  /** The projects whose own answer it is, whatever the machine's is. */
  projects?: readonly string[]
  /** Whether the orchestrator runs as it; null or absent where it talks through another harness. */
  forOrchestrator?: boolean | null
  canSignIn: boolean
  /**
   * What would put its harness on this machine, where it is not here: the
   * line setup offers, or why nothing here can. Absent or null where it is.
   */
  install?: { command: string } | { cannot: string } | null
}

/**
 * Everything that can be done to accounts, account by account and harness by
 * harness, in the order the page draws them — which is the order the
 * keyboard walks them, since both come from here.
 */
export function accountActions(accounts: readonly AccountShown[]): AccountAction[] {
  const actions: AccountAction[] = []
  const id = (verb: string, harness: string, name: string | null) =>
    `account:${verb}:${harness}:${name ?? ''}`
  const harnesses = [...new Set(accounts.map((one) => one.harness))]
  for (const harness of harnesses) {
    const mine = accounts.filter((one) => one.harness === harness)
    for (const one of mine) {
      const at = one.name
      if (one.kind === 'api-key') {
        actions.push({
          id: id('key', harness, at),
          label: one.status.signedIn ? 'Change its key…' : 'Set its key…',
          harness,
          account: at,
        })
      } else if (one.canSignIn) {
        actions.push({
          id: id('sign-in', harness, at),
          label: one.status.signedIn ? 'Sign in again…' : 'Sign in…',
          harness,
          account: at,
        })
        // Signing out is the harness's own, for one that keeps accounts apart.
        if (one.status.signedIn && one.canAdd) {
          actions.push({ id: id('sign-out', harness, at), label: 'Sign out', harness, account: at })
        }
      }
      if (!one.forNewAgents && (one.canAdd || mine.length > 1)) {
        actions.push({
          id: id('use', harness, at),
          label: 'Use for new agents',
          harness,
          account: at,
        })
      }
      // The way off a plan the orchestrator has used up: it cannot be asked to
      // move itself with no turns left. Written as `orchestrator.account`.
      if (one.forOrchestrator === false) {
        actions.push({
          id: id('orchestrator', harness, at),
          label: 'Use for the orchestrator',
          harness,
          account: at,
        })
      }
      if (at !== null) {
        actions.push({
          id: id('remove', harness, at),
          label: 'Remove',
          danger: true,
          harness,
          account: at,
        })
      }
    }
    if (mine.some((one) => one.canAdd)) {
      actions.push({ id: id('add', harness, null), label: 'Add an account…', harness })
      actions.push({ id: id('add-key', harness, null), label: 'Add an API-key account…', harness })
    }
  }
  return actions
}

/** Carry out an account action, asking twice for the one that cannot be undone. */
export function accountChoice(panel: SettingsPanel, id: string): PanelOutcome {
  if (id.startsWith('account:remove:') && panel.confirm !== id) {
    return stay({ ...panel, confirm: id, saved: null, error: null })
  }
  return { panel: { ...panel, confirm: null }, submit: true, choice: id }
}
