import { isAbsolute, normalize, resolve } from 'node:path'

// What may an agent do without asking, what needs a word, and what needs you
// to say the command back.
//
// A pure function of the tool call, so it is exhaustively table-tested. The
// gate in the worker adapter holds every tool call; this decides which ones
// you ever hear about.

export const Tier = {
  /** Run it. Reading and editing inside the task's own worktree. */
  auto: 'auto',
  /** One spoken word is enough. */
  soft: 'soft',
  /** Read the exact command back; a bare yes must never be enough. */
  hard: 'hard',
} as const
export type Tier = (typeof Tier)[keyof typeof Tier]

export interface ToolCallFacts {
  tool: string
  input: unknown
  /** The task's worktree. Everything outside it is someone else's property. */
  worktree: string | null
}

export interface PolicyDecision {
  tier: Tier
  /** Which rule decided, for the approval ledger. */
  rule: string
  /** One clause explaining why, to say out loud. */
  reason: string
}

/**
 * A rule somebody wrote for their own machine.
 *
 * It can only ever make Wilco *stricter*: there is no `auto` to write, and
 * where a rule disagrees with a built-in the stricter of the two wins. Wilco's
 * own list is a floor, not a default — loosening is `auto_allow`, which names
 * exact tools and is a deliberate thing to type.
 */
export interface PolicyRule {
  /** Matched against the command, as a regular expression. */
  match: string
  tier: 'soft' | 'hard'
  /** One clause to say out loud. Falls back to the pattern. */
  reason?: string
}

export interface PolicyOptions {
  /** Per-project allowlist of tools that never ask. */
  autoAllow?: string[]
  /** Extra rules from the config, which may only tighten things. */
  rules?: readonly PolicyRule[]
}

const STRICTNESS: Record<Tier, number> = { auto: 0, soft: 1, hard: 2 }

/**
 * The first of your own rules that matches, if any is stricter than what Wilco
 * decided on its own. Unreadable patterns are skipped rather than thrown over:
 * `wilco config --check` is where a bad one is reported, and an agent mid-turn
 * is not the moment to find out about a typo.
 */
function yours(command: string, decided: PolicyDecision, rules: readonly PolicyRule[]) {
  for (const rule of rules) {
    if (STRICTNESS[rule.tier] <= STRICTNESS[decided.tier]) continue
    let pattern: RegExp
    try {
      pattern = new RegExp(rule.match)
    } catch {
      continue
    }
    if (!pattern.test(command)) continue
    return {
      tier: rule.tier as Tier,
      rule: `yours:${rule.match}`,
      reason: rule.reason ?? rule.match,
    }
  }
  return null
}

/**
 * `bypass` is the default: the agent is never held up. `policy` turns on the
 * tiers above, which is what makes spoken approvals possible.
 */
export type ApprovalMode = 'bypass' | 'policy'

export interface ApprovalSettings {
  mode: ApprovalMode
  autoAllow?: string[]
  rules?: readonly PolicyRule[]
}

export interface Approval extends PolicyDecision {
  decision: 'allow' | 'ask'
}

/**
 * What the gate should do with a held tool call. The risk classification runs
 * either way, so `wilco logs` can still show that a force push happened even
 * when nothing asked you about it.
 */
export function decideApproval(facts: ToolCallFacts, settings: ApprovalSettings): Approval {
  const classified = classifyToolCall(facts, {
    ...(settings.autoAllow ? { autoAllow: settings.autoAllow } : {}),
    ...(settings.rules ? { rules: settings.rules } : {}),
  })
  if (settings.mode === 'bypass') return { ...classified, decision: 'allow' }
  return { ...classified, decision: classified.tier === Tier.auto ? 'allow' : 'ask' }
}

/** Tools that only look at things. */
const READ_ONLY = new Set(['read', 'ls', 'find', 'grep', 'glob'])
/** Tools that change files, checked against the worktree boundary. */
const FILE_WRITES = new Set(['write', 'edit', 'multiedit', 'apply_patch'])

interface Rule {
  rule: string
  reason: string
  test: RegExp
}

// Ordered: the first match wins, so the most serious patterns come first.
const HARD_COMMANDS: Rule[] = [
  { rule: 'sudo', reason: 'runs as root', test: /(^|[\s;&|])sudo(\s|$)/ },
  {
    rule: 'force-push',
    reason: 'force push',
    test: /\bgit\b[^;&|]*\bpush\b[^;&|]*(--force\b|--force-with-lease\b|\s-f(\s|$))/,
  },
  {
    rule: 'history-rewrite',
    reason: 'rewrites history',
    test: /\bgit\b[^;&|]*\b(rebase|filter-branch|filter-repo|reflog\s+expire)\b|\bgit\b[^;&|]*reset\s+--hard\b/,
  },
  {
    rule: 'branch-delete',
    reason: 'deletes a branch',
    test: /\bgit\b[^;&|]*(branch\s+-D\b|push\b[^;&|]*--delete\b|push\b[^;&|]*\s:\S)/,
  },
  {
    rule: 'credentials',
    reason: 'touches credentials',
    test: /(^|[\s"'/=])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.netrc|credentials\.json)(\s|$|["'])/,
  },
  {
    rule: 'publish',
    reason: 'publishes outside this machine',
    test: /\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b|\bgh\s+release\s+create\b/,
  },
  {
    rule: 'migration',
    reason: 'changes a database',
    test: /\b(prisma\s+migrate\s+(deploy|reset)|alembic\s+(upgrade|downgrade)|rails\s+db:migrate|drop\s+(table|database)|truncate\s+table)\b/i,
  },
]

const SOFT_COMMANDS: Rule[] = [
  {
    rule: 'network',
    reason: 'reaches the network',
    test: /\b(curl|wget|ssh|scp|rsync)\b|\b(npm|pnpm|yarn)\s+(install|add)\b|\bpip\s+install\b|\bbrew\s+install\b/,
  },
  { rule: 'push', reason: 'pushes to a remote', test: /\bgit\b[^;&|]*\bpush\b/ },
  { rule: 'pr', reason: 'opens a pull request', test: /\bgh\s+pr\s+create\b/ },
]

/** Commands that only read, so they need no permission at all. */
const READ_ONLY_COMMANDS =
  /^(\s*(ls|cat|head|tail|pwd|which|file|stat|wc|grep|rg|fd|find|git\s+(status|log|diff|show|branch(\s+-v)?|remote\s+-v))\b[^;&|]*)$/

export function classifyToolCall(
  facts: ToolCallFacts,
  options: PolicyOptions = {},
): PolicyDecision {
  if (options.autoAllow?.includes(facts.tool)) {
    return { tier: Tier.auto, rule: 'allowlisted', reason: `${facts.tool} is allowed here` }
  }

  const input = (facts.input ?? {}) as Record<string, unknown>
  const path = firstString(input, ['path', 'file_path', 'filePath', 'file'])

  if (READ_ONLY.has(facts.tool)) {
    if (path && mentionsCredentials(path)) {
      return { tier: Tier.hard, rule: 'credentials', reason: 'reads credentials' }
    }
    return { tier: Tier.auto, rule: 'read-only', reason: `${facts.tool} only reads` }
  }

  if (FILE_WRITES.has(facts.tool)) {
    if (path && mentionsCredentials(path)) {
      return { tier: Tier.hard, rule: 'credentials', reason: 'writes credentials' }
    }
    if (!path) return { tier: Tier.soft, rule: 'write-unknown-path', reason: 'writes a file' }
    return inside(path, facts.worktree)
      ? { tier: Tier.auto, rule: 'write-in-worktree', reason: 'edits its own worktree' }
      : { tier: Tier.hard, rule: 'write-outside-worktree', reason: `writes outside the worktree` }
  }

  const command = firstString(input, ['command', 'script', 'cmd'])
  if (command === null) {
    return { tier: Tier.soft, rule: 'unknown-tool', reason: `${facts.tool} is not a known tool` }
  }
  const mine = classifyCommand(command, facts)
  return yours(command, mine, options.rules ?? []) ?? mine
}

/** What Wilco makes of a command on its own, before your rules are consulted. */
function classifyCommand(command: string, facts: ToolCallFacts): PolicyDecision {
  for (const rule of HARD_COMMANDS) {
    if (rule.test.test(command)) return { tier: Tier.hard, rule: rule.rule, reason: rule.reason }
  }
  const recursiveDelete = deletesOutside(command, facts.worktree)
  if (recursiveDelete) {
    return { tier: Tier.hard, rule: 'recursive-delete', reason: `deletes ${recursiveDelete}` }
  }
  for (const rule of SOFT_COMMANDS) {
    if (rule.test.test(command)) return { tier: Tier.soft, rule: rule.rule, reason: rule.reason }
  }
  if (READ_ONLY_COMMANDS.test(command)) {
    return { tier: Tier.auto, rule: 'read-only-command', reason: 'only reads' }
  }
  return { tier: Tier.soft, rule: 'command', reason: 'runs a command' }
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function mentionsCredentials(text: string): boolean {
  return /(^|[\s"'/=])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.ssh\/|\.aws\/|\.netrc)(\s|$|["'])/.test(
    `${text} `,
  )
}

/** True when `path` resolves inside `worktree`. Unknown worktree means no. */
export function inside(path: string, worktree: string | null): boolean {
  if (!worktree) return false
  if (path.startsWith('~')) return false
  const absolute = isAbsolute(path) ? normalize(path) : resolve(worktree, path)
  const root = normalize(worktree)
  return absolute === root || absolute.startsWith(`${root}/`)
}

/**
 * `rm -rf build` inside a task's worktree is routine. The same command aimed
 * anywhere else is not, so the target decides the tier, not the flags.
 */
function deletesOutside(command: string, worktree: string | null): string | null {
  const match = /\brm\s+(-[a-zA-Z]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*)\s+(.+)$/.exec(command)
  if (!match) return null
  const targets = (match[3] ?? '')
    .split(/[;&|]/)[0]!
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'))
  for (const target of targets) {
    const cleaned = target.replace(/^["']|["']$/g, '')
    if (cleaned === '/' || cleaned === '/*') return 'the filesystem root'
    if (!inside(cleaned, worktree)) return cleaned
  }
  return null
}
