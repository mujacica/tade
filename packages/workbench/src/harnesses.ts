import { ClaudeAdapter } from '@tade/harnesses-claude'
import { CodexAdapter } from '@tade/harnesses-codex'
import type { HarnessAccount, RunId, WorkerAdapter } from '@tade/harnesses-core'
import { PiAdapter } from '@tade/harnesses-pi'

// The harnesses agents can run in, by name: the one registry every call site
// goes through, so adding a harness is an adapter and a line here — never a
// `new` somewhere that assumed there was only ever pi.

export interface HarnessOptions {
  runDir: string
  socketDir: string
  approvals: 'bypass' | 'policy'
  /** Where pi keeps its sessions, when not its own default: for tests. */
  sessionsRoot?: string
  /**
   * Type into an agent's terminal. A harness that listens nowhere else — no
   * extension inside it to send a message to — is told things this way, as a
   * person would tell it.
   */
  type?: (run: RunId, text: string) => Promise<void>
  onWarning?: (message: string) => void
  /** The account it runs as, when not the harness's own sign-in. */
  account?: HarnessAccount
  /** Whose home a harness's own sign-in is found in: for tests, so none reads yours. */
  home?: string
  /**
   * Whether Tade watches and gates what this agent does. False for the
   * orchestrator: it is Tade's own interface, and asking permission to answer
   * "where are we" is not a question anybody wants.
   */
  supervised?: boolean
  /** Extra arguments appended to every launch, for tests that need a harness told something. */
  args?: string[]
}

/**
 * How an account's adapter is filed beside its harness's own: `claude-code`
 * for the harness's own sign-in, `claude-code@work` for the account "work".
 */
export function adapterKey(harness: string, account?: string | null): string {
  return account ? `${harness}@${account}` : harness
}

/** Where Tade keeps an API-key account's key: named so no extension's can collide with it. */
export function accountKey(name: string): string {
  return `accounts.${name}.key`
}

export const HARNESS_ADAPTERS: Readonly<Record<string, (opts: HarnessOptions) => WorkerAdapter>> = {
  pi: (opts) => new PiAdapter({ ...opts, supervise: opts.supervised ?? true }),
  'claude-code': (opts) => new ClaudeAdapter(opts),
  codex: (opts) => new CodexAdapter(opts),
}
