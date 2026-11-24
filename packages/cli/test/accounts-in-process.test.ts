import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { run } from '../src/program.ts'

// `tade accounts`, run in this worker the way `bin.ts` runs it, where
// `accounts.test.ts` runs the binary. What is held here is what only asks: the
// list as a terminal reads it and as a script does, every refusal and its exit
// code, and a sign-in or sign-out that cannot happen saying why — never one
// that runs a harness's own sign-in, which takes the keyboard. Adding,
// choosing and removing open the workbench, and stay with the binary's test.

let saved: NodeJS.ProcessEnv

beforeEach(() => {
  saved = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

/**
 * A home of its own with `config` in it, and a PATH with nothing on it, so no
 * harness's program is here: nothing asked of Claude Code or Codex reaches the
 * one on the machine running the suite, and each says how it would be installed.
 */
function home(config: string) {
  const dir = tmp('tade-cli-accounts-here-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(dir, 'config.yaml'), config)
  return { dir, bin, config: join(dir, 'config.yaml') }
}

/** `tade <args>` over `where`: what it printed, and its exit code. */
async function tade(where: { dir: string; bin: string }, args: string[]) {
  Object.assign(process.env, {
    HOME: where.dir,
    TADE_HOME: where.dir,
    PATH: where.bin,
    TADE_NO_GH: '1',
  })
  const out: string[] = []
  const err: string[] = []
  const code = await run(['node', 'tade', ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

type View = {
  harness: string
  name: string | null
  forNewAgents: boolean
  projects: string[]
  status: { signedIn: boolean; problem: string | null }
  install: { command: string } | { cannot: string } | null
}

describe('tade accounts, listing', () => {
  it('says each sign-in once, the one new agents run as marked, a project that chose it, and how to install a harness that is not here', async () => {
    const repo = mkrepo()
    const where = home(
      'accounts:\n  work:\n    harness: claude-code\n' +
        `projects:\n  app:\n    root: ${repo.root}\n    accounts:\n      claude-code: work\n`,
    )
    const json = await tade(where, ['accounts', '--json', '-c', where.config])
    expect(json.code, json.err).toBe(0)
    const views = JSON.parse(json.out) as View[]
    expect(views.map((view) => [view.harness, view.name])).toEqual([
      ['pi', null],
      ['claude-code', null],
      ['claude-code', 'work'],
      ['codex', null],
      ['acp', null],
    ])
    const claude = views[1] as View
    const work = views[2] as View
    // The machine's own sign-in is still what new agents run as; only `app` chose `work`.
    expect(claude.forNewAgents).toBe(true)
    expect(work).toMatchObject({ forNewAgents: false, projects: ['app'] })
    // Not on this PATH, so it cannot be signed in and is said with how to get it.
    expect(claude.status.signedIn).toBe(false)
    expect(claude.install).not.toBeNull()
    // An added account is the same program, so how to install it is said once.
    expect(work.install).toBeNull()

    const text = await tade(where, ['accounts', '-c', where.config])
    expect(text.code, text.err).toBe(0)
    const lines = text.out.split('\n')
    // One row per sign-in, then a line under it, indented past the names, for
    // each thing it has to add.
    const rows = lines.filter((line) => /^(▸| ) \S/.test(line))
    expect(rows).toHaveLength(views.length)
    rows.forEach((row, at) => {
      const view = views[at] as View
      expect(row.startsWith(view.forNewAgents ? '▸ ' : '  ')).toBe(true)
      expect(row).toContain(view.name ? `${view.harness} · ${view.name}` : view.harness)
      if (!view.status.signedIn) expect(row).toContain(view.status.problem ?? 'not signed in')
    })
    const under = (row: string) => lines[lines.indexOf(row) + 1] ?? ''
    const workRow = rows.find((row) => row.includes('claude-code · work')) ?? ''
    expect(under(workRow).trim()).toBe('new agents in app')
    const claudeRow = rows.find((row) => /claude-code\s/.test(row)) ?? ''
    const install = claude.install as { command: string } | { cannot: string }
    expect(under(claudeRow).trim()).toBe('command' in install ? install.command : install.cannot)
  }, 60_000)

  it('lists the own sign-in by the name it was given', async () => {
    const where = home('workers:\n  default_names:\n    claude-code: sentry\n')
    const text = await tade(where, ['accounts', '-c', where.config])
    expect(text.code, text.err).toBe(0)
    expect(text.out).toContain('claude-code · sentry')
  }, 60_000)
})

describe('tade accounts, refusing', () => {
  it('refuses a config it cannot read with exit 2 and how to find out why, whatever was asked', async () => {
    const where = home('accounts: [unclosed\n')
    for (const args of [
      ['accounts'],
      ['accounts', '--json'],
      ['accounts', 'sign-in', 'claude-code'],
      ['accounts', 'sign-out', 'claude-code'],
    ]) {
      const said = await tade(where, [...args, '-c', where.config])
      expect(said.code, args.join(' ')).toBe(2)
      expect(said.err).toBe(`${where.config}: invalid config (run \`tade config --check\`)`)
      expect(said.out).toBe('')
    }
  }, 60_000)

  it('names the harnesses there are when asked for one there is not', async () => {
    const where = home('')
    const said = await tade(where, ['accounts', 'sign-in', 'cursor', '-c', where.config])
    expect(said.code).toBe(2)
    expect(said.err).toBe('no harness called cursor: there are pi, claude-code, codex, acp')
  }, 60_000)

  it('says which account it does not know, and one of another harness is not this one', async () => {
    const where = home('accounts:\n  work:\n    harness: codex\n')
    for (const name of ['nope', 'work']) {
      const said = await tade(where, [
        'accounts',
        'sign-in',
        'claude-code',
        name,
        '-c',
        where.config,
      ])
      expect(said.code, name).toBe(2)
      expect(said.err).toBe(`no claude-code account called ${name}`)
    }
  }, 60_000)

  it('says a sign-in whose program is not on the PATH could not start, and how to fix it', async () => {
    // What a remote's sign-in did over SSH with Claude Code in ~/.local/bin:
    // exit 1 and nothing after Tade's own line. The PATH here has no `claude`.
    const where = home('')
    const said = await tade(where, ['accounts', 'sign-in', 'claude-code', '-c', where.config])
    expect(said.code).toBe(1)
    expect(said.err).toBe(
      "claude is not on the PATH here, so its sign-in could not start: install it, or put the folder it is in on the PATH — a command over SSH gets the system's PATH, not your login shell's",
    )
  }, 60_000)

  it('signs in the orchestrator’s own harness and account with --orchestrator, read out of this config', async () => {
    // What another machine's `/login` runs here over its link. Claude Code is
    // not on this PATH, so its sign-in is the one that could not start: the
    // orchestrator's harness, chosen here and named by nobody.
    const where = home('orchestrator:\n  harness: claude-code\n')
    const said = await tade(where, ['accounts', 'sign-in', '--orchestrator', '-c', where.config])
    expect(said.code).toBe(1)
    expect(said.err).toContain('claude is not on the PATH here')
    // And the account it runs as, where that is one paid for with a key.
    const keyed = home(
      'accounts:\n  ci:\n    harness: claude-code\n    kind: api-key\norchestrator:\n  harness: claude-code\n  account: ci\n',
    )
    const key = await tade(keyed, ['accounts', 'sign-in', '--orchestrator', '-c', keyed.config])
    expect(key.code).toBe(2)
    expect(key.err).toBe('ci is paid for with an API key: set it in Settings, Accounts')
  }, 60_000)

  it('asks for a harness or --orchestrator, and never both', async () => {
    const where = home('')
    const none = await tade(where, ['accounts', 'sign-in', '-c', where.config])
    expect(none.code).toBe(2)
    expect(none.err).toBe(
      "name a harness, or --orchestrator for the orchestrator's: `tade accounts sign-in claude-code`",
    )
    const both = await tade(where, [
      'accounts',
      'sign-out',
      'pi',
      '--orchestrator',
      '-c',
      where.config,
    ])
    expect(both.code).toBe(2)
    expect(both.err).toBe(
      '--orchestrator names its own harness and account: `tade accounts sign-out --orchestrator`',
    )
  }, 60_000)

  it('sends an account paid for with a key to Settings rather than signing it in', async () => {
    const where = home('accounts:\n  ci:\n    harness: claude-code\n    kind: api-key\n')
    const said = await tade(where, ['accounts', 'sign-in', 'claude-code', 'ci', '-c', where.config])
    expect(said.code).toBe(2)
    expect(said.err).toBe('ci is paid for with an API key: set it in Settings, Accounts')
    expect(said.out).toBe('')
  }, 60_000)

  it('says where a harness that signs out its own way is signed out', async () => {
    const where = home('')
    const pi = await tade(where, ['accounts', 'sign-out', 'pi', '-c', where.config])
    expect(pi.code).toBe(2)
    expect(pi.err).toBe('pi signs out inside pi: open it and type /logout')
    const acp = await tade(where, ['accounts', 'sign-out', 'acp', '-c', where.config])
    expect(acp.code).toBe(2)
    expect(acp.err).toBe('each ACP agent signs out its own way, in its own terminal')
    expect(pi.out + acp.out).toBe('')
  }, 60_000)
})
