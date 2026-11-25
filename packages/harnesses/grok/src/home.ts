import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The folder a Grok account lives in (`GROK_HOME`), and what Tade keeps in it.
//
// Claude Code takes a run's hooks and tool servers on its command line
// (`--settings`, `--mcp-config`); Grok takes neither. Its per-run overlay
// (`GROK_CONFIG`) refuses `hooks` and `mcp_servers` by design, and an agent
// definition handed to it (`--agent`) would replace the agent it runs as. What
// it does read is its home: hook files in `$GROK_HOME/hooks/`, servers and the
// status line in `$GROK_HOME/config.toml`. So every account Tade runs Grok as —
// its own sign-in included — is a folder of Tade's, the way a Codex account is
// a `CODEX_HOME` of its own, and the person signs in to Grok once in it
// (`grok login` with `GROK_HOME` set). Tade never reads, copies or links the
// `auth.json` Grok writes there.
//
// Everything Tade writes into it is inert without the supervision environment
// (`TADE_RUN_SOCKET`), so one static setup serves every run, and a `grok`
// somebody starts in the folder by hand behaves as if Tade were not there:
//
// - `hooks/tade.json`, Tade's own file, written whole every time;
// - `[mcp_servers.tade]` and `[ui.status_line]` in `config.toml` — the two
//   tables Tade owns there, replaced in place and nothing else touched, since
//   Grok's own `/settings` writes that file too, key by key;
// - a `trusted_folders.toml` entry for each folder an agent is started in,
//   because an untrusted folder stops Grok with a question before anything
//   else happens, and holds back the hooks until it is answered.
//
// What Grok would otherwise bring in from Claude Code's and Cursor's own
// settings — their hooks, firing inside a Tade lane, and their MCP servers,
// attaching to it — is switched off per launch by environment
// (`COMPAT_OFF`), which outranks any `config.toml`.

/** Where Grok keeps everything when nobody says otherwise: what a person's own `grok` uses. */
export function ownGrokHome(home = homedir()): string {
  return join(home, '.grok')
}

/**
 * Grok's switches for what it reads out of other tools' settings, off for
 * their hooks and their MCP servers. Their skills, rules and instruction
 * files stay: a project's `CLAUDE.md` is the project's, and Tade's own uses one.
 */
export const COMPAT_OFF: Readonly<Record<string, string>> = {
  GROK_CLAUDE_HOOKS_ENABLED: 'false',
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CURSOR_HOOKS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
}

/**
 * What of your own `~/.grok` an account of Tade's is given, linked, when
 * shared: your skills, agents, rules, workflows and how its terminal looks.
 * Never its sign-in, its sessions or its config, which are the account's own,
 * and never its hooks, which would run inside every agent.
 */
const SHARED = ['skills', 'agents', 'rules', 'workflows', 'pager.toml', 'lsp.json']

/** The programs Tade's hooks, status line and tool server are: node, and a file of ours. */
export interface HomeParts {
  node: string
  hook: string
  statusline: string
  mcp: string
  /** Whether a hook that fails holds the call it was asked about (`policy`), or lets it go (`bypass`). */
  gated: boolean
}

/** A word the shell reads back as itself. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** A TOML basic string: the six escapes it defines, and nothing else raw. */
export function tomlString(said: string): string {
  let out = '"'
  for (const ch of said) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

/** Write a file whole, then put it in place: Grok never reads half of one. */
function writeWhole(path: string, text: string): void {
  // Unchanged, it is left: a launch that writes nothing new touches nothing.
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return
  const writing = `${path}.tade-writing`
  writeFileSync(writing, text, { mode: 0o600 })
  renameSync(writing, path)
}

/**
 * The hooks every run reports through, in the shape Grok reads out of a hook
 * file (Claude Code's matcher groups). The gate's timeout is a day, because a
 * call held for a person waits for as long as they take, and Grok's own
 * default of five seconds would let it through unanswered. Under `policy` it
 * fails closed (`failClosed`): a gate that crashed, or could not start, refuses
 * the call rather than letting it run unasked; under `bypass` nothing was ever
 * going to be held, and a broken hook must not stop an agent that was told it
 * would not be.
 */
export function hooksFile(parts: HomeParts): string {
  const command = `${shellWord(parts.node)} ${shellWord(parts.hook)}`
  const hook = (timeout: number, extra: Record<string, unknown> = {}) => [
    { hooks: [{ type: 'command', command, timeout, ...extra }] },
  ]
  const hooks = {
    SessionStart: hook(30),
    UserPromptSubmit: hook(30),
    PreToolUse: hook(24 * 60 * 60, parts.gated ? { failClosed: true } : {}),
    PostToolUse: hook(30),
    PostToolUseFailure: hook(30),
    Stop: hook(30),
    StopFailure: hook(30),
    StopCancelled: hook(30),
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/** A line that opens a table, or an array of tables, and the table's name. */
function headerOf(line: string): string | null {
  const m = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line)
  return m?.[1] ? m[1].replace(/\s*\.\s*/g, '.').replace(/"/g, '') : null
}

/** What Tade writes above its tables, so a person opening the file knows whose they are. */
const MARK = [
  '# Written by Tade, which starts Grok agents in this folder. Inert unless Tade',
  '# started the agent; each launch writes these two tables again.',
]

/** Whether a table is one Tade owns in an account's config. */
function ours(table: string): boolean {
  return (
    table === 'mcp_servers.tade' ||
    table.startsWith('mcp_servers.tade.') ||
    table === 'ui.status_line' ||
    table.startsWith('ui.status_line.')
  )
}

/**
 * An account's `config.toml` with Tade's two tables said afresh, and what was
 * there before them: every other line kept exactly as it was. A table of ours
 * is the header and every line under it up to the next header; one Grok wrote
 * back inline, under its parent (`status_line = {…}` in `[ui]`, `tade = {…}`
 * in `[mcp_servers]`), is that one line. What the status line ran before, when
 * it was not Tade's, is handed back, so it can be run in front of.
 */
export function withOurTables(
  text: string,
  parts: HomeParts,
): { text: string; theirStatusLine: string | null } {
  const kept: string[] = []
  let table = ''
  let skipping = false
  let theirs: string | null = null
  for (const line of text.split('\n')) {
    if (MARK.includes(line)) continue
    const header = headerOf(line)
    if (header !== null) {
      table = header
      skipping = ours(header)
      if (skipping) continue
    }
    if (skipping) {
      if (table === 'ui.status_line') {
        const command = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
        if (command && !command.includes('statusline.ts')) theirs = JSON.parse(`"${command}"`)
      }
      continue
    }
    if (
      (table === 'ui' && /^\s*status_line\s*=/.test(line)) ||
      (table === 'mcp_servers' && /^\s*"?tade"?\s*=/.test(line))
    ) {
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === '') kept.pop()
  const node = tomlString(parts.node)
  const ourTables = [
    ...MARK,
    '[mcp_servers.tade]',
    `command = ${node}`,
    `args = [${tomlString(parts.mcp)}]`,
    'startup_timeout_sec = 60',
    '',
    '[ui.status_line]',
    'type = "command"',
    `command = ${tomlString(`${shellWord(parts.node)} ${shellWord(parts.statusline)}`)}`,
  ]
  const before = kept.join('\n')
  return {
    text: `${before}${before ? '\n\n' : ''}${ourTables.join('\n')}\n`,
    theirStatusLine: theirs,
  }
}

/** Where an account keeps the status line it had before Tade's was put in front of it. */
function theirsFile(home: string): string {
  return join(home, 'tade-statusline')
}

/**
 * Make an account's folder ready for a run: private, Tade's hooks and its two
 * tables in place, and — the first time the folder is made, when sharing —
 * your own skills and the rest linked in. Returns the status line the account
 * had of its own, if any. Synchronous, because the line that launches a run is.
 */
export function readyHome(
  home: string,
  parts: HomeParts,
  opts: { share?: string | null } = {},
): { theirStatusLine: string | null } {
  const made = !existsSync(join(home, 'hooks'))
  mkdirSync(join(home, 'hooks'), { recursive: true, mode: 0o700 })
  // Private, however it came to be: a `grok` that runs in a folder that is
  // not there yet makes it readable by anybody, and its sign-in is kept here.
  chmodSync(home, 0o700)
  if (made && opts.share) {
    for (const entry of SHARED) {
      const from = join(opts.share, entry)
      const to = join(home, entry)
      if (!existsSync(from) || existsSync(to)) continue
      symlinkSync(from, to)
    }
  }
  writeWhole(join(home, 'hooks', 'tade.json'), hooksFile(parts))
  const config = join(home, 'config.toml')
  const was = existsSync(config) ? readFileSync(config, 'utf8') : ''
  const next = withOurTables(was, parts)
  if (next.text !== was) writeWhole(config, next.text)
  if (next.theirStatusLine) writeWhole(theirsFile(home), next.theirStatusLine)
  const kept = existsSync(theirsFile(home)) ? readFileSync(theirsFile(home), 'utf8').trim() : ''
  return { theirStatusLine: kept || null }
}

/**
 * `trusted_folders.toml` with `folders` marked trusted, as Grok itself writes
 * the answer to its "do you trust this directory?" — a table per folder,
 * keyed by its path — and nothing else of the file changed. A folder already
 * in it, trusted or not, is left as it is: somebody who said no in the lane
 * said it on purpose.
 */
export function withTrusted(text: string, folders: readonly string[], now: number): string {
  const lines = text.trimEnd() ? [text.trimEnd()] : []
  const there = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*\[\s*folders\.("(?:[^"\\]|\\.)*")\s*\]/.exec(line)
    if (m?.[1]) there.add(JSON.parse(m[1]) as string)
  }
  for (const folder of new Set(folders)) {
    if (there.has(folder)) continue
    lines.push(
      `[folders.${tomlString(folder)}]\ntrusted = true\ndecided_at = ${Math.floor(now / 1000)}`,
    )
  }
  return lines.length > 0 ? `${lines.join('\n\n')}\n` : ''
}

/**
 * Mark the folder an agent is started in as trusted for this account, under
 * the name it was given and its real one — a worktree Tade calls `/var/…` is
 * `/private/var/…` on macOS, and whichever Grok looks it up by is the one
 * that has to be there.
 */
export async function trustIn(home: string, cwd: string, now = Date.now()): Promise<void> {
  const real = await realpath(cwd).catch(() => cwd)
  const file = join(home, 'trusted_folders.toml')
  const was = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const next = withTrusted(was, [cwd, real], now)
  if (next !== was) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeWhole(file, next)
  }
}
