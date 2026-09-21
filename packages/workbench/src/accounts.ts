import { join } from 'node:path'
import { type Config, type HarnessId, type PlanWindow, secretCommand } from '@tade/core'
import type { AccountStatus, HarnessAccount, PlanLimits, WorkerAdapter } from '@tade/harnesses-core'
import { accountKey, HARNESS_ADAPTERS } from './harnesses.ts'

// The accounts agents can run as: each harness's own sign-in, and the ones a
// person added beside it. Read by the window and by `tade accounts`, which
// must answer while a window is open — so none of this needs the workbench.

/** One account a harness's agents can run as, as the Accounts page shows it. */
export interface AccountView {
  harness: string
  /** Null for the harness's own sign-in. */
  name: string | null
  kind: 'subscription' | 'api-key'
  /** Whether this harness can have accounts beside its own. */
  canAdd: boolean
  /** Why not, in its words, when it cannot. */
  why: string | null
  status: AccountStatus
  limits: PlanLimits | null
  /** Agents running as it now. */
  agents: number
  /** The one this harness's new agents run as. */
  forNewAgents: boolean
  /** Whether it has a sign-in of its own to run. */
  canSignIn: boolean
}

/**
 * A harness's two named windows as plain ones, labelled with what each covers.
 *
 * The port names them `fiveHour` and `sevenDay` because that is what both
 * subscription harnesses are told; this is the one place those names become
 * words somebody reads, so nothing downstream has to know either harness.
 */
export function planWindows(limits: {
  fiveHour: { used: number; resetsAt: number } | null
  sevenDay: { used: number; resetsAt: number } | null
}): PlanWindow[] {
  return [
    limits.fiveHour ? { label: '5h', ...limits.fiveHour } : null,
    limits.sevenDay ? { label: '7d', ...limits.sevenDay } : null,
  ].filter((one) => one !== null)
}

/**
 * An account as its harness is given it: its folder under Tade's home, and
 * for one paid for with an API key, the command that reads that key from
 * where Tade keeps it — never the key.
 */
export function harnessAccount(config: Config, home: string, name: string): HarnessAccount {
  const account = config.accounts[name]
  if (!account) throw new Error(`no account called ${name}`)
  return {
    name,
    dir: join(home, 'accounts', name),
    kind: account.kind,
    ...(account.kind === 'api-key' ? { key: secretCommand(home, accountKey(name)) } : {}),
  }
}

/**
 * Every account there is, as each harness says it stands: who it is signed in
 * as — asked now — how much of its plan is used, and how many agents run as
 * it. Never throws: a harness that cannot answer says so in `status.problem`.
 */
export async function listAccounts(
  config: Config,
  opts: {
    adapterFor: (harness: string, name: string | null) => WorkerAdapter
    agentsOn?: (adapter: WorkerAdapter) => number
  },
): Promise<AccountView[]> {
  const views: AccountView[] = []
  for (const harness of Object.keys(HARNESS_ADAPTERS)) {
    const names = [
      null,
      ...Object.entries(config.accounts)
        .filter(([, account]) => account.harness === harness)
        .map(([name]) => name),
    ]
    const chosen = config.workers.accounts[harness as HarnessId] ?? null
    for (const name of names) {
      const adapter = opts.adapterFor(harness, name)
      const status: AccountStatus = await adapter.account().catch((err: unknown) => ({
        signedIn: false,
        who: null,
        plan: null,
        method: null,
        problem: (err as Error).message,
      }))
      views.push({
        harness,
        name,
        kind: name ? (config.accounts[name]?.kind ?? 'subscription') : 'subscription',
        canAdd: adapter.capabilities.accounts,
        why: adapter.capabilities.accounts ? null : (adapter.capabilities.why.accounts ?? null),
        status,
        limits: adapter.limits(),
        agents: opts.agentsOn?.(adapter) ?? 0,
        forNewAgents: chosen === name,
        canSignIn: adapter.signIn() !== null,
      })
    }
  }
  return views
}
