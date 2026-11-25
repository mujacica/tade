import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  fromTomlString,
  type HomeParts,
  readyHome,
  withOurTables,
  withTrusted,
} from '../src/home.ts'

// An account's GROK_HOME: what Tade writes there, and that it touches nothing
// else of what is in it — Grok's own /settings writes the same config.

const parts: HomeParts = {
  node: '/usr/bin/node',
  hook: '/opt/tade/harnesses/grok/src/hook.ts',
  statusline: '/opt/tade/harnesses/grok/src/statusline.ts',
  mcp: '/opt/tade/harnesses/grok/src/mcp.ts',
  gated: false,
}

describe('the config Tade keeps two tables of', () => {
  it('says its two tables, and keeps every other line exactly as it was', () => {
    const was = '[models]\ndefault = "grok-4.6"\n\n[ui]\ntheme = "dark"\n'
    const { text } = withOurTables(was, parts)
    expect(text.startsWith(was.trimEnd())).toBe(true)
    expect(text).toContain('[mcp_servers.tade]\ncommand = "/usr/bin/node"\n')
    expect(text).toContain('args = ["/opt/tade/harnesses/grok/src/mcp.ts"]')
    expect(text).toContain('[ui.status_line]\ntype = "command"')
    // Said again, it is the same file: nothing piles up.
    expect(withOurTables(text, parts).text).toBe(text)
  })

  it('replaces its own tables wherever Grok wrote them back, inline ones too', () => {
    const was = [
      '[mcp_servers]',
      'tade = { command = "/old/node", args = ["/old/mcp.ts"] }',
      'other = { command = "x" }',
      '',
      '[ui]',
      'status_line = { type = "builtin" }',
      'theme = "dark"',
      '',
      '[mcp_servers.tade.env]',
      'A = "b"',
    ].join('\n')
    const { text } = withOurTables(was, parts)
    expect(text).not.toContain('/old/')
    expect(text).not.toContain('A = "b"')
    expect(text).not.toContain('builtin')
    expect(text).toContain('other = { command = "x" }')
    expect(text).toContain('theme = "dark"')
    expect(text.match(/\[mcp_servers\.tade\]/g)).toHaveLength(1)
  })

  it('hands back a status line of the account’s own, so it is run in front of rather than lost', () => {
    const was = '[ui.status_line]\ntype = "command"\ncommand = "~/bin/my line.sh"\n'
    expect(withOurTables(was, parts).theirStatusLine).toBe('~/bin/my line.sh')
    expect(withOurTables(withOurTables(was, parts).text, parts).theirStatusLine).toBeNull()
  })

  it('reads a status line written with escapes TOML has and JSON does not, without stopping', () => {
    const was = '[ui.status_line]\ntype = "command"\ncommand = "printf \\e[1m\\U0001F600 \\q"\n'
    expect(withOurTables(was, parts).theirStatusLine).toBe('printf \u001b[1m😀 \\q')
    expect(fromTomlString('a\\"b\\\\c\\u0041\\UFFFFFFFF')).toBe('a"b\\cA\\UFFFFFFFF')
  })
})

describe('the folders it trusts', () => {
  it('adds a folder as Grok writes one, once, and leaves one somebody said no to alone', () => {
    const was = '[folders."/work/no"]\ntrusted = false\ndecided_at = 1\n'
    const text = withTrusted(was, ['/work/yes', '/work/no', '/work/yes'], 1_795_000_000_000)
    expect(text).toContain('[folders."/work/no"]\ntrusted = false')
    expect(text).toContain('[folders."/work/yes"]\ntrusted = true\ndecided_at = 1795000000')
    expect(text.match(/\/work\/yes/g)).toHaveLength(1)
    expect(withTrusted(text, ['/work/yes'], 0)).toBe(text)
  })
})

describe('an account folder made ready', () => {
  it('is narrowed to private when Grok made it first, readable by anybody', () => {
    const home = join(tmp('tade-grok-acct-'), 'grok')
    mkdirSync(home, { mode: 0o755 })
    chmodSync(home, 0o755)
    readyHome(home, parts)
    expect(statSync(home).mode & 0o777).toBe(0o700)
  })

  it('leaves a file that would be written the same as it was', () => {
    const home = join(tmp('tade-grok-acct-'), 'grok')
    readyHome(home, parts)
    const hooks = join(home, 'hooks', 'tade.json')
    const before = statSync(hooks).ino
    readyHome(home, parts)
    expect(statSync(hooks).ino).toBe(before)
  })

  it('is private, holds Tade’s hooks, and is given your own skills the first time when shared', () => {
    const mine = tmp('tade-grok-mine-')
    mkdirSync(join(mine, 'skills'))
    writeFileSync(join(mine, 'auth.json'), '{"token":"yours"}')
    writeFileSync(join(mine, 'config.toml'), '[models]\ndefault = "grok-4.5"\n')
    const home = join(tmp('tade-grok-acct-'), 'grok')
    readyHome(home, parts, { share: mine })
    expect(lstatSync(home).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(home, 'skills')).isSymbolicLink()).toBe(true)
    // Never the sign-in, and never the config: those are the account's own.
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('grok-4.5')
    expect(
      JSON.parse(readFileSync(join(home, 'hooks', 'tade.json'), 'utf8')).hooks.Stop,
    ).toHaveLength(1)
  })
})
