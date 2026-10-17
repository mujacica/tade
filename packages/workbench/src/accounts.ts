import { join } from 'node:path'
import {
  type Config,
  type HarnessId,
  type InstallCommand,
  type InstallersHere,
  installWith,
  type PlanChoice,
  type PlanSource,
  type PlanWindow,
  planStandings,
  secretCommand,
  windowLabel,
} from '@tade/core'
import type { AccountStatus, HarnessAccount, PlanLimits, WorkerAdapter } from '@tade/harnesses-core'
import { accountKey, HARNESS_ADAPTERS } from './harnesses.ts'
import { harnessProgram, installersHere, programHere } from './installers.ts'

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
  /**
   * The provider this harness's own sign-in pays for, as the harness declares
   * it (`WorkerAdapter.provider`) — `anthropic` for Claude Code, `openai` for
   * Codex. Null where a harness reaches many and names none, which is pi: its
   * providers are its own `auth.json`'s to say, one per model.
   *
   * Here because being signed in to a harness *is* having a credential for
   * the provider it talks to, and the window had no way to know that: it read
   * one harness's credentials and drew everything else as "not signed in",
   * so an orchestrator on a live Claude subscription said it had no account.
   */
  provider: string | null
  /**
   * What would put its harness on this machine, where its program is not
   * here — on the harness's own row, and null everywhere else. The line setup
   * offers, out of the harness's own declaration and this machine's
   * installers, so "Claude Code is not installed" comes with what to run, and
   * says plainly where nothing here can.
   */
  install: InstallCommand | null
}

/**
 * A harness's windows as the ones a plan is drawn with, each labelled by how
 * long it is (`windowLabel`), in the order the harness gave them.
 *
 * The one place a window's length becomes a word somebody reads, so nothing
 * downstream has to know any harness. They were labelled by slot — `5h` for
 * the short one whatever it covered — and a Codex plan with one window of
 * thirty days read `5h` everywhere a plan is drawn.
 */
export function planWindows(limits: {
  windows: readonly { minutes: number; used: number; resetsAt: number }[]
}): PlanWindow[] {
  return limits.windows.map((one) => ({
    label: windowLabel(one.minutes),
    used: one.used,
    resetsAt: one.resetsAt,
  }))
}

/**
 * Every sign-in agents could run as: each harness's own, and the accounts a
 * person added beside it, in the order the harnesses are registered.
 *
 * One list, read by the Accounts page and by what each of them says about its
 * plan, so neither can know about a sign-in the other does not.
 */
export function signIns(config: Config): { harness: string; name: string | null }[] {
  const out: { harness: string; name: string | null }[] = []
  for (const harness of Object.keys(HARNESS_ADAPTERS)) {
    out.push({ harness, name: null })
    for (const [name, account] of Object.entries(config.accounts)) {
      if (account.harness === harness) out.push({ harness, name })
    }
  }
  return out
}

/**
 * How much of each sign-in's plan is used, as its harness last said, beside
 * what that harness is able to say at all.
 *
 * **Every** sign-in there is, not only the ones something has already run as.
 * An account nobody has used yet used to be absent, on the argument that
 * absence said the same thing as "has said nothing" — and for a bar drawing one
 * account it did. It stops being true the moment somebody asks what else there
 * is when a plan is nearly gone: an account that exists and has said nothing is
 * somewhere to go, and an absent row is one nobody can suggest.
 *
 * Never asks anybody anything: a harness that is told its own limits keeps the
 * last answer it was given, and this reads it. Anything reaching out here would
 * be a network call on the window's beat, which is the thing that must not
 * happen. Making an adapter is the whole of what this costs, it happens once
 * per sign-in, and it is the very adapter that would answer that account's runs.
 *
 * "None used" and "cannot know" are different answers, only one of them is good
 * news, and which it is is `planStandings`' to decide from the harness's own
 * declaration rather than from an empty figure.
 */
export function planSources(
  config: Config,
  opts: { adapterFor: (harness: string, name: string | null) => WorkerAdapter },
): PlanSource[] {
  return signIns(config).map(({ harness, name }) => {
    const adapter = opts.adapterFor(harness, name)
    const can = adapter.capabilities.spend.limits
    const said = can === 'none' ? null : adapter.limits()
    return {
      harness,
      account: name,
      can,
      pays: paysFor(config, name, adapter),
      why: adapter.capabilities.why.limits ?? null,
      said: said ? { at: said.at, windows: planWindows(said) } : null,
    }
  })
}

/**
 * Every sign-in's plan, after asking each one that can be asked without running
 * anything (`anytime`) and has nothing true to say yet — all at once, each
 * within `timeoutMs` — or only `only`, where a start names the one it would
 * spend.
 *
 * The one place a plan is asked rather than read, and only when somebody is
 * about to decide on it: before an unknown plan lets a start through to find
 * out (`planTooTight`), which reads only the sign-in that start would spend, so
 * asking any other would be a wait that changes nothing. A sign-in that could
 * not answer says what it said before, which is nothing — asking never makes a
 * figure up.
 */
export async function askPlans(
  config: Config,
  opts: { adapterFor: (harness: string, name: string | null) => WorkerAdapter },
  timeoutMs: number,
  only?: PlanChoice,
): Promise<PlanSource[]> {
  const before = planSources(config, opts)
  const standings = planStandings(before, Date.now())
  await Promise.all(
    before.map(async (source, at) => {
      if (source.can !== 'anytime' || source.pays !== 'plan') return
      if (only && (source.harness !== only.harness || source.account !== only.account)) return
      if (standings[at]?.cannotTell === null) return
      // Never throws, by the port's word; what it could not hear it has said.
      await opts.adapterFor(source.harness, source.account).askLimits(timeoutMs)
    }),
  )
  return planSources(config, opts)
}

/**
 * What pays for a sign-in's turns, which is what says whether it has a window
 * to be used up at all.
 *
 * An added account answers with the kind a person wrote down for it: an API key
 * is money per token, whatever its harness can say about prices. Codex is why
 * that is not read off `spend.usd` — it declares it prices nothing on any
 * account, which is true of Codex and says nothing about who is billed.
 *
 * A harness's own sign-in has only its own declaration to go on, and that is
 * the right answer there: `none` is a harness that cannot be charged per turn,
 * which is a plan, and pi pricing every turn is not one.
 */
function paysFor(
  config: Config,
  name: string | null,
  adapter: WorkerAdapter,
): 'plan' | 'per-token' {
  if (name) return config.accounts[name]?.kind === 'api-key' ? 'per-token' : 'plan'
  return adapter.capabilities.spend.usd === 'none' ? 'plan' : 'per-token'
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
    /** Where each harness's program is looked for: this process's unless a test says. */
    env?: NodeJS.ProcessEnv
    /** What this machine installs with: looked at here unless a test says. */
    machine?: InstallersHere
  },
): Promise<AccountView[]> {
  const env = opts.env ?? process.env
  const machine = opts.machine ?? installersHere(env)
  const views: AccountView[] = []
  for (const { harness, name } of signIns(config)) {
    const chosen = config.workers.accounts[harness as HarnessId] ?? null
    const adapter = opts.adapterFor(harness, name)
    const status: AccountStatus = await adapter.account().catch((err: unknown) => ({
      signedIn: false,
      who: null,
      plan: null,
      method: null,
      problem: (err as Error).message,
    }))
    // A PATH lookup, and only on the harness's own row: an added account is
    // the same program, said once where the harness is.
    const program = name === null ? harnessProgram(adapter, harness) : undefined
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
      provider: adapter.provider,
      install: program && !programHere(program, env) ? installWith(program.install, machine) : null,
    })
  }
  return views
}
