import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { type HeadlessLaunch, headlessArgs, headlessEnv, SNAPSHOT_OPTION } from '../src/headless.ts'
import { optionsOf } from '../src/installed.ts'

// The orchestrator's launch: a conversation whose id never changes, so
// nothing it was told may be pinned at the first turn — neither the system
// prompt nor a tool's schema.

const launch = (over: Partial<HeadlessLaunch> = {}): HeadlessLaunch => ({
  mcp: ['/run/tade-tools.mcp.json'],
  session: 'c83ee2f5-4133-5616-a324-24315cb23dde',
  going: true,
  model: null,
  effort: null,
  instructions: null,
  plugin: null,
  snapshot: true,
  extra: [],
  ...over,
})

/** The value an option was given on a line. */
const given = (args: readonly string[], option: string): string | undefined =>
  args[args.indexOf(option) + 1]

describe('the line', () => {
  it('asks for the system prompt fresh on every request, where Claude Code takes the option', () => {
    expect(given(headlessArgs(launch()), SNAPSHOT_OPTION)).toBe('off')
  })

  it('leaves the option off a Claude Code that does not take it, which would refuse to start', () => {
    expect(headlessArgs(launch({ snapshot: false }))).not.toContain(SNAPSHOT_OPTION)
  })

  it('puts the MCP configs first, where they cannot swallow what follows', () => {
    const args = headlessArgs(launch({ mcp: ['/a.json', '/b.json'] }))
    expect(args.slice(0, 3)).toEqual(['--mcp-config', '/a.json', '/b.json'])
  })

  it('has no --mcp-config at all with no config to give it', () => {
    expect(headlessArgs(launch({ mcp: [] }))).not.toContain('--mcp-config')
  })

  it('takes the conversation up again, or makes it under its id', () => {
    expect(given(headlessArgs(launch()), '--resume')).toBe(launch().session)
    expect(given(headlessArgs(launch({ going: false })), '--session-id')).toBe(launch().session)
  })
})

describe('the environment', () => {
  const spec = { run: 'tade/orchestrator/agent', task: 'tade/orchestrator', cwd: '/', prompt: '' }

  it('declares every tool whole, so a changed schema reaches the model', () => {
    expect(headlessEnv({}, spec).ENABLE_TOOL_SEARCH).toBe('false')
  })

  it('keeps it so when the window inherited the opposite from wherever Tade was opened', () => {
    const env = headlessEnv(
      { HOME: '/account' },
      { ...spec, env: { ENABLE_TOOL_SEARCH: 'true', HOME: '/caller' } },
    )
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
    // Everything else the caller passed still wins over the account's.
    expect(env.HOME).toBe('/caller')
  })

  it('says which run and task it is', () => {
    const env = headlessEnv({}, spec)
    expect(env.TADE_RUN_ID).toBe(spec.run)
    expect(env.TADE_TASK_ID).toBe(spec.task)
  })
})

/** A `claude` whose `--help` says `help`, and which writes down how it was started. */
function fakeClaude(help: string[] | null): string {
  const bin = join(tmp('tade-claude-fake-'), 'claude')
  const said = help === null ? 'exit 2' : `printf '%s\\n' ${help.map((l) => `'${l}'`).join(' ')}`
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      // Broken while `<bin>.broken` exists: a look that failed.
      'if [ "$1" = "--help" ] && [ -e "$0.broken" ]; then exit 2; fi',
      `if [ "$1" = "--help" ]; then ${said}; exit 0; fi`,
      'printf \'%s\\n\' "$@" > "$0.args.tmp"',
      'echo "$ENABLE_TOOL_SEARCH" > "$0.search"',
      'mv "$0.args.tmp" "$0.args"',
      'exec sleep 600',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  -r, --resume [value]                  Resume a conversation by session ID, or',
  '  --mcp-config <configs...>             Load MCP servers from JSON files or',
  '  --system-prompt-snapshot <on|off>     Record the system prompt once per',
]

describe('what the Claude Code here takes', () => {
  it('is the options --help lists', async () => {
    const options = await optionsOf(fakeClaude(HELP), process.env)
    expect(options?.has('--resume')).toBe(true)
    expect(options?.has(SNAPSHOT_OPTION)).toBe(true)
  })

  it('is not an option one of the descriptions names', async () => {
    const options = await optionsOf(
      fakeClaude([
        '  -c, --continue                        Continue the most recent conversation;',
        `                                        ${SNAPSHOT_OPTION} is not here yet`,
      ]),
      process.env,
    )
    expect(options?.has('--continue')).toBe(true)
    expect(options?.has(SNAPSHOT_OPTION)).toBe(false)
  })

  it('cannot be told by one that would not answer, which is not one that offers nothing', async () => {
    expect(await optionsOf(fakeClaude(null), process.env)).toBeNull()
  })
})

describe('starting the orchestrator', () => {
  let adapter: ClaudeAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  const started = async (help: string[] | null, bin = fakeClaude(help), run = 'agent') => {
    rmSync(`${bin}.args`, { force: true })
    adapter ??= new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: tmp('tade-claude-account-'),
      home: tmp('tade-claude-home-'),
      bin,
      type: async () => {},
    })
    await adapter.start({
      run: `tade/orchestrator/${run}`,
      task: 'tade/orchestrator',
      cwd: tmp('tade-claude-cwd-'),
      prompt: '',
      env: { ENABLE_TOOL_SEARCH: 'true' },
      extras: { mcp: ['/run/tade-tools.mcp.json'] },
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(`${bin}.args`)) {
      if (Date.now() > deadline) throw new Error('the fake claude never started')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return {
      args: readFileSync(`${bin}.args`, 'utf8').trimEnd().split('\n'),
      search: readFileSync(`${bin}.search`, 'utf8').trim(),
    }
  }

  it('starts it with nothing pinned', async () => {
    const { args, search } = await started(HELP)
    expect(given(args, SNAPSHOT_OPTION)).toBe('off')
    expect(search).toBe('false')
  })

  it('still starts it on a Claude Code too old to be asked', async () => {
    const { args, search } = await started(HELP.slice(0, 3))
    expect(args).not.toContain(SNAPSHOT_OPTION)
    expect(args).toContain('-p')
    expect(search).toBe('false')
  })

  it('asks again after a look that failed, rather than going without for the life of the window', async () => {
    const bin = fakeClaude(HELP)
    writeFileSync(`${bin}.broken`, '')
    expect((await started(HELP, bin, 'one')).args).not.toContain(SNAPSHOT_OPTION)
    rmSync(`${bin}.broken`)
    expect(given((await started(HELP, bin, 'two')).args, SNAPSHOT_OPTION)).toBe('off')
  })

  it('hands it one server called tade: its own tools, never the adapter’s lane server beside them', async () => {
    const { args } = await started(HELP)
    expect(args.slice(0, 3)).toEqual(['--mcp-config', '/run/tade-tools.mcp.json', '-p'])
  })
})
