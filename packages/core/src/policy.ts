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

/**
 * What a tool does to the world, as its harness knows it. The harness says,
 * because only it knows its own tool names: pi's `edit` and Claude Code's
 * `Edit` are one thing, and a table of names here would know one of them.
 * `exec` is judged by its command.
 */
export type ToolEffect = 'read' | 'write' | 'exec' | 'other'

export interface ToolCallFacts {
  tool: string
  input: unknown
  /** The task's worktree. Everything outside it is someone else's property. */
  worktree: string | null
  /** What the tool does, from its harness. Absent, it is judged by pi's tool names. */
  effect?: ToolEffect
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
 * It can only ever make Tade *stricter*: there is no `auto` to write, and
 * where a rule disagrees with a built-in the stricter of the two wins. Tade's
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
 * The first of your own rules that matches, if any is stricter than what Tade
 * decided on its own. Unreadable patterns are skipped rather than thrown over:
 * `tade config --check` is where a bad one is reported, and an agent mid-turn
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
 * either way, so `tade logs` can still show that a force push happened even
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

/**
 * What a second reading of a command may add.
 *
 * Never an approval and never a denial: a tier, and the sentence a person
 * reads instead of a number. Whatever wrote it is something that can write —
 * a rule's own words — because "0.91" explains nothing to somebody woken by it.
 */
export interface Caution {
  /** The tier it would have instead. Only ever stricter than Tade's own. */
  tier: 'soft' | 'hard'
  /** One clause to say out loud, as somebody wrote it. */
  reason: string
  /** What read it, for the ledger: an extension's name. */
  by: string
  /** The version that answered, kept so a threshold can be argued with later. */
  version?: string
}

/**
 * The approval as it stands after a second reading of the command.
 *
 * It may only ever add caution: a stricter tier than Tade decided on its own,
 * never a looser one, and never an allow of something that was going to be
 * asked about. A reading that says nothing, or says something weaker, leaves
 * the decision exactly as it was — which is also what happens when nobody read
 * it at all, and is why this is safe on a path that may time out.
 *
 * `bypass` still never holds anything up. That is the mode's promise, and a
 * second reading is not a reason to break it: what changes there is the record,
 * which is how a command nothing asked about is still found later.
 */
export function withCaution(
  approval: Approval,
  caution: Caution | null,
  settings: ApprovalSettings,
): Approval {
  if (!caution) return approval
  if (STRICTNESS[caution.tier] <= STRICTNESS[approval.tier]) return approval
  return {
    tier: caution.tier,
    rule: `${approval.rule}+${caution.by}`,
    reason: caution.reason,
    decision: settings.mode === 'bypass' ? 'allow' : 'ask',
  }
}

/** pi's tools that only look at things. */
const READ_ONLY = new Set(['read', 'ls', 'find', 'grep', 'glob'])
/** pi's tools that change files, checked against the worktree boundary. */
const FILE_WRITES = new Set(['write', 'edit', 'multiedit', 'apply_patch'])

/**
 * What a tool does, judged by pi's names: for a call whose harness did not
 * say. A command tool is found by its input rather than its name, so `exec`
 * is never needed from here.
 */
export function effectByName(tool: string): ToolEffect {
  if (READ_ONLY.has(tool)) return 'read'
  if (FILE_WRITES.has(tool)) return 'write'
  return 'other'
}

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
  const path = firstString(input, ['path', 'file_path', 'filePath', 'file', 'notebook_path'])
  const effect = facts.effect ?? effectByName(facts.tool)

  if (effect === 'read') {
    if (path && mentionsCredentials(path)) {
      return { tier: Tier.hard, rule: 'credentials', reason: 'reads credentials' }
    }
    return { tier: Tier.auto, rule: 'read-only', reason: `${facts.tool} only reads` }
  }

  if (effect === 'write') {
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

/** What Tade makes of a command on its own, before your rules are consulted. */
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

// --- a harness's own yes/no ---------------------------------------------------

/**
 * What a harness's own permission prompt asks about: Claude Code, launched to
 * bypass its permissions, still stops on a few things — writes into `.git` or
 * `.claude`, a command it rates dangerous — and waits for somebody to press y
 * in a lane nobody may be looking at. Tade answers that question by this rule
 * instead, at once, and never waits on a person for it.
 */
export interface PromptFacts {
  tool: string
  input: unknown
  /** What the tool does, from its harness. */
  effect: ToolEffect
  /**
   * Where the agent may change things without asking: the task's workspace
   * first — what a relative path is read against — then its repository's own
   * git folder, which for a worktree is outside the worktree (`.git/hooks`).
   */
  roots: readonly string[]
  /**
   * The harness's own scratch and temporary folders, which are the agent's as
   * much as its workspace is: `$TMPDIR`, and Claude Code's scratchpad under
   * `/tmp/claude-<uid>/`. An entry ending in `*` is every folder whose name
   * starts so (`/tmp/claude-*`). Never a reason to allow credentials.
   */
  scratch?: readonly string[]
  /**
   * Where the agent is standing as it asks, which a relative path in a command
   * is read against. Unknown, a relative path is not judged at all.
   */
  cwd?: string | null
  /** The home folder of whoever runs the agent: off limits outside `roots`. */
  home: string | null
}

export interface PromptAnswer {
  allow: boolean
  /** Which rule decided, for the journal. */
  rule: string
  /** One clause saying why, which a refusal hands the agent in its message. */
  reason: string
}

/** Commands that are refused wherever they point, the most serious first. */
const REFUSED_COMMANDS: readonly Rule[] = [
  { rule: 'sudo', reason: 'it runs as root', test: /(^|[\s;&|(`])sudo(\s|$)/ },
  {
    rule: 'force-push',
    reason: 'it force-pushes, which rewrites what other people have',
    test: /\bgit\b[^;&|]*\bpush\b[^;&|]*(--force\b|--force-with-lease\b|--force-if-includes\b|\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)|\s\+\S)/,
  },
  {
    rule: 'ref-delete',
    reason: 'it deletes a branch or a tag',
    test: /\bgit\b[^;&|]*(\bbranch\b[^;&|]*\s(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)(\s|$)|\btag\b[^;&|]*\s(-[a-zA-Z]*d[a-zA-Z]*|--delete)(\s|$)|\bpush\b[^;&|]*(\s--delete\b|\s-d(\s|$)|\s:\S)|\bupdate-ref\s+-d\b)/,
  },
]

/** Places that hold keys and sign-ins, wherever they are. `.env.example` and its kind are not. */
const CREDENTIAL_PLACES =
  /(^|[\s"'/=:])(\.env(?!\.(example|sample|template|defaults)\b)(\.[\w-]+)?|id_rsa[\w.-]*|id_ed25519[\w.-]*|id_ecdsa[\w.-]*|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker\/config\.json|\.kube\/config|credentials\.json|\.tade\/config\.yaml)(\/|\s|$|["';)])/

/** The files a shell reads as it starts, which change every terminal somebody opens. */
const SHELL_RC =
  /(^|[\s"'/=:])(\.(bash|zsh)(rc|env|_profile|_login|_logout)|\.profile|\.zprofile|\.zshenv|\.zlogin|\.config\/fish\/)(\/|\s|$|["';)])/

/** Paths every command may name and none of which is anybody's property. */
const HARMLESS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/**
 * Tade's answer to a harness's own permission prompt, by rule.
 *
 * Allowed: anything that stays inside `roots` — editing `.git/hooks`, removing
 * build output, a command that names nothing outside. Refused, with a reason
 * the agent reads: running as root; force-pushing; deleting a branch or a tag;
 * touching keys, credentials, Tade's `config.yaml` or a shell's startup files;
 * and reaching the home folder or anywhere else outside the project.
 *
 * Pure, and deterministic on purpose: it is what stands in for a person who is
 * not there, so it is read the same by the window and by a hook answering on
 * its own. It never widens what `policy` mode holds — under `policy` the
 * prompt is left to the person, and this is not asked.
 */
export function answerPrompt(facts: PromptFacts): PromptAnswer {
  const input = (facts.input ?? {}) as Record<string, unknown>
  const command =
    facts.effect === 'exec' || facts.effect === 'other'
      ? firstString(input, ['command', 'script', 'cmd'])
      : null
  if (command !== null) {
    // Only what the command itself says: a heredoc's body and a quoted script
    // are text the program reads, not places the command names — an import
    // path inside a Python edit was refused, live, before they were dropped.
    const { skeleton, words } = argumentsOf(command)
    for (const rule of REFUSED_COMMANDS) {
      if (rule.test.test(skeleton)) return refuse(rule.rule, rule.reason)
    }
    for (const word of words) {
      if (CREDENTIAL_PLACES.test(` ${word} `)) {
        return refuse('credentials', `it touches keys or credentials (${word})`)
      }
      if (SHELL_RC.test(` ${word} `)) {
        return refuse('shell-rc', `it changes a shell's startup files (${word})`)
      }
    }
    // A command that moves first has paths read from where it moved to,
    // which no reading of its words can be sure of: those are let be.
    const moves = /(^|[\s;&|(])(cd|pushd|popd)(\s|$)/.test(skeleton)
    return placesAnswer(pathsIn(words, moves ? null : (facts.cwd ?? null)), facts, facts.cwd)
  }
  const path = firstString(input, ['file_path', 'path', 'filePath', 'file', 'notebook_path'])
  return placesAnswer(path ? [path] : [], facts, facts.cwd ?? facts.roots[0] ?? null)
}

function refuse(rule: string, reason: string): PromptAnswer {
  return { allow: false, rule, reason }
}

/** Every place named, judged against `from` where relative: the first one refused decides. */
function placesAnswer(
  paths: readonly string[],
  facts: PromptFacts,
  from: string | null | undefined,
): PromptAnswer {
  for (const path of paths) {
    if (HARMLESS.has(path)) continue
    if (CREDENTIAL_PLACES.test(` ${path} `)) {
      return refuse('credentials', `it touches keys or credentials (${path})`)
    }
    if (SHELL_RC.test(` ${path} `)) {
      return refuse('shell-rc', `it changes a shell's startup files (${path})`)
    }
    const absolute = placeOf(path, facts, from ?? null)
    if (absolute === null) {
      return refuse('home', `it reaches into the home folder (${path})`)
    }
    if (facts.roots.some((root) => inside(absolute, root))) continue
    if ((facts.scratch ?? []).some((place) => inScratch(absolute, place))) continue
    if (facts.home && inside(absolute, facts.home)) {
      return refuse('home', `it reaches into the home folder, outside the project (${path})`)
    }
    return refuse('outside', `it reaches outside the project (${path})`)
  }
  return { allow: true, rule: 'in-workspace', reason: 'it stays inside its own workspace' }
}

/**
 * Whether an absolute path is in a scratch place: inside it, or, for one ending
 * in `*`, inside any folder whose name starts with what comes before the `*`.
 * The path is already normalised, so no `..` can climb back out of one.
 */
function inScratch(absolute: string, place: string): boolean {
  if (!place.endsWith('*')) return inside(absolute, place)
  const prefix = normalize(place.slice(0, -1))
  if (prefix.endsWith('/') || !absolute.startsWith(prefix)) return false
  const name = absolute.slice(prefix.lastIndexOf('/') + 1).split('/')[0] ?? ''
  return name.length > prefix.length - prefix.lastIndexOf('/') - 1
}

/**
 * Where a path is, absolute: `~` and `$HOME` read against the home folder, a
 * relative path against the workspace. Null for a home-relative path when no
 * home is known, which is refused rather than guessed at.
 */
function placeOf(path: string, facts: PromptFacts, from: string | null): string | null {
  const home = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(path)
  if (home) return facts.home ? normalize(`${facts.home}${path.slice(home[0].length)}`) : null
  if (path.startsWith('~')) return null
  if (isAbsolute(path)) return normalize(path)
  return from ? resolve(from, path) : null
}

/**
 * The places a command names, as far as its words can say: every word that is
 * an absolute path or starts at the home folder, a flag's value (`--git-dir=/x`)
 * and a redirection's target included — and, where `cwd` is known, a relative
 * one that climbs with `..`. Lexical: nothing is expanded or followed, an
 * address (`https://…`) is not a path, and a word built from anything but
 * `$HOME` (`$OUT/x`, `$(pwd)/y`) cannot be read, so it is let be.
 */
function pathsIn(words: readonly string[], cwd: string | null): string[] {
  const out: string[] = []
  for (const word of words) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue
    const value =
      word.startsWith('-') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : word
    if (/\$(?!\{?HOME\b)|`/.test(value)) continue
    // A pattern, not a place: a regex or a glob (`/\\B`, `/src/*.ts`) cannot
    // be placed, so it is let be.
    if (/[\\*?[\]{}^|+]/.test(value)) continue
    if (value.startsWith('/') || value.startsWith('~') || /^\$\{?HOME\b/.test(value)) {
      out.push(value)
    } else if (cwd && /(^|\/)\.\.(\/|$)/.test(value)) {
      out.push(value)
    }
  }
  return out
}

/**
 * A command as the shell would split it, with what is not its own arguments
 * taken out: each heredoc's body, and every quoted string with a space or a
 * line in it — a script handed to `python -c`, a message, a body — which is
 * text a program reads rather than a place the command names. `skeleton` is
 * the command with those taken out, for the rules that read a whole command;
 * `words` its words, quotes taken off.
 */
export function argumentsOf(command: string): { skeleton: string; words: string[] } {
  const text = withoutHeredocs(command)
  const words: string[] = []
  let skeleton = ''
  let word = ''
  let body = false
  let quote: '"' | "'" | null = null
  let quoted = ''
  const end = (): void => {
    if (word && !body) words.push(word)
    word = ''
    body = false
  }
  for (let at = 0; at < text.length; at += 1) {
    const one = text[at] ?? ''
    if (quote) {
      if (one === '\\' && quote === '"' && at + 1 < text.length) {
        quoted += text[at + 1]
        at += 1
      } else if (one === quote) {
        if (/\s/.test(quoted)) {
          body = true
          skeleton += "''"
        } else {
          word += quoted
          skeleton += quoted
        }
        quote = null
        quoted = ''
      } else {
        quoted += one
      }
      continue
    }
    if (one === '"' || one === "'") {
      quote = one
      continue
    }
    if (one === '\\' && at + 1 < text.length) {
      word += text[at + 1]
      skeleton += text.slice(at, at + 2)
      at += 1
      continue
    }
    skeleton += one
    if (/[\s;&|()<>]/.test(one)) end()
    else word += one
  }
  // An unclosed quote is a body nobody finished: not an argument.
  end()
  return { skeleton, words }
}

/** A command with each heredoc's body taken out, its `<<WORD` left where it was. */
function withoutHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  const ends: string[] = []
  for (const line of lines) {
    if (ends.length > 0) {
      if (line.replace(/^\t+/, '').trimEnd() === ends[0]) ends.shift()
      continue
    }
    out.push(line)
    for (const found of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) {
      if (found[2]) ends.push(found[2])
    }
  }
  return out.join('\n')
}
