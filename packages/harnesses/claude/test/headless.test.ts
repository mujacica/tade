import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import {
  type HeadlessLaunch,
  headlessArgs,
  headlessEnv,
  SNAPSHOT_OPTION,
  serverDown,
  serversIn,
} from '../src/headless.ts'
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

  it('carries none of the run Tade was opened from inside', () => {
    // The parent agent's, in the window's environment, which is the account's
    // too; `spec.env` is what `toolEnv` hands over, with these left out.
    const parent = {
      TADE_RUN_SOCKET: '/run/parent.sock',
      TADE_APPROVALS: 'policy',
      TADE_EXTENSION_TOOLS: '/run/parent-tools.json',
      TADE_RUN_ID: 'other/agent',
      TADE_TASK_ID: 'other',
    }
    const env = headlessEnv(parent, { ...spec, env: { HOME: '/caller' } })
    expect(env).not.toHaveProperty('TADE_RUN_SOCKET')
    expect(env).not.toHaveProperty('TADE_APPROVALS')
    expect(env).not.toHaveProperty('TADE_EXTENSION_TOOLS')
    expect(env.TADE_RUN_ID).toBe(spec.run)
    expect(env.TADE_TASK_ID).toBe(spec.task)
  })

  it('says its own extension tools, and only those', () => {
    const env = headlessEnv(
      { TADE_EXTENSION_TOOLS: '/run/parent-tools.json' },
      { ...spec, extras: { tools: '/run/own-tools.json' } },
    )
    expect(env.TADE_EXTENSION_TOOLS).toBe('/run/own-tools.json')
  })

  it('gives its tool server three minutes to come up, and a call fifteen to answer', () => {
    // Thirty seconds is Claude Code's own, and a server that misses it is
    // given up on for the whole session: on a machine at a load average of a
    // hundred, Tade's took 41 to 54 seconds, and the orchestrator ran for
    // hours with none of its tools.
    const env = headlessEnv({}, spec)
    expect(env.MCP_TIMEOUT).toBe('180000')
    expect(env.MCP_TOOL_TIMEOUT).toBe('900000')
  })
})

describe('the tool servers a turn begins with', () => {
  // What a real 2.1.308 said in its `system/init` line, given a server that
  // answered `initialize` after its deadline.
  const init = {
    type: 'system',
    subtype: 'init',
    mcp_servers: [
      { name: 'tade', status: 'failed', source: 'dynamic' },
      { name: 'linear', status: 'connected', source: 'dynamic' },
      { name: 'slow', status: 'pending' },
      { name: 7, status: 'failed' },
    ],
  }

  it('reads each server and how it stands, and nothing it cannot place', () => {
    expect(serversIn(init)).toEqual([
      { name: 'tade', status: 'failed' },
      { name: 'linear', status: 'connected' },
      { name: 'slow', status: 'pending' },
    ])
    expect(serversIn({ type: 'system', subtype: 'init' })).toEqual([])
    expect(serversIn({ mcp_servers: 'tade' })).toEqual([])
  })

  it('counts a server down unless it is up or still coming up', () => {
    expect(serversIn(init).map(serverDown)).toEqual([true, false, false])
    expect(serverDown({ name: 'tade', status: 'needs-auth' })).toBe(true)
  })
})

/** Whether a process is there, a zombie included: one reaped is not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
      'echo "$MCP_TIMEOUT" > "$0.wait"',
      'mv "$0.args.tmp" "$0.args"',
      // Who started it — the reaper between it and the adapter — one a line.
      'echo "$PPID" >> "$0.parents"',
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
      wait: readFileSync(`${bin}.wait`, 'utf8').trim(),
    }
  }

  it('starts it with nothing pinned', async () => {
    const { args, search } = await started(HELP)
    expect(given(args, SNAPSHOT_OPTION)).toBe('off')
    expect(search).toBe('false')
  })

  it('starts it with time for its tools to come up, through whatever stands between', async () => {
    // The reaper sits between the adapter and `claude`: what reaches the
    // process is what counts, not what the adapter meant to pass.
    expect((await started(HELP)).wait).toBe('180000')
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

  it('hears nothing from one it stopped, and keeps the one started again under its id', async () => {
    // A restart — another account, another model — stops it and starts it
    // again under the same run id. The one stopped ends after: its exit was
    // said as `failed` to whoever listened under that id, and took the new
    // run out of the adapter with it.
    const bin = fakeClaude(HELP)
    await started(HELP, bin)
    const run = 'tade/orchestrator/agent'
    const heard: string[] = []
    adapter?.onSignal(run, (signal) => heard.push(signal.type))
    await adapter?.stop(run)
    await started(HELP, bin)
    const stopped = Number(readFileSync(`${bin}.parents`, 'utf8').split('\n')[0])
    // Gone is reaped, and the adapter hears an exit in the same callback.
    const deadline = Date.now() + 10_000
    while (alive(stopped)) {
      if (Date.now() > deadline) throw new Error('the stopped one never ended')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(heard).toEqual([])
    expect((await adapter?.list())?.map((one) => one.run)).toEqual([run])
  })
})

/**
 * A `claude` that speaks the protocol and begins each turn with the next of
 * `states` as its tool server's standing, the way a real one lists its servers
 * in the `system/init` line every turn begins with.
 */
function fakeTurns(states: string[]): string {
  const bin = join(tmp('tade-claude-turns-'), 'claude')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env node',
      "if (process.argv[2] === '--help') process.exit(0)",
      `const states = ${JSON.stringify(states)}`,
      'const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n")',
      "let rest = ''",
      'let turn = 0',
      "process.stdin.on('data', (chunk) => {",
      '  rest += chunk',
      "  for (let end = rest.indexOf('\\n'); end >= 0; end = rest.indexOf('\\n')) {",
      '    rest = rest.slice(end + 1)',
      '    const status = states[turn++] ?? "connected"',
      "    say({ type: 'system', subtype: 'init', session_id: 'same', mcp_servers: [{ name: 'tade', status }, { name: 'linear', status: 'connected' }] })",
      "    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here.' }] } })",
      "    say({ type: 'result', subtype: 'success', result: 'Here.', is_error: false })",
      '  }',
      '})',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('a tool server that did not connect', () => {
  let adapter: ClaudeAdapter | null = null
  afterEach(async () => {
    await adapter?.shutdown()
    adapter = null
  })

  it('is said when it is first seen down, and again only after it was up', async () => {
    // Claude Code gives up on a server for the session and says so nowhere
    // but here: the model finds out when a tool is not there.
    adapter = new ClaudeAdapter({
      runDir: tmp('tcc-'),
      configDir: tmp('tade-claude-account-'),
      home: tmp('tade-claude-home-'),
      bin: fakeTurns(['failed', 'failed', 'connected', 'pending', 'failed']),
      type: async () => {},
    })
    const run = 'tade/orchestrator/agent'
    const signals: WorkerSignal[] = []
    adapter.onSignal(run, (signal) => signals.push(signal))
    await adapter.start({
      run,
      task: 'tade/orchestrator',
      cwd: tmp('tade-claude-cwd-'),
      prompt: '',
    })
    for (let turn = 1; turn <= 5; turn++) {
      await adapter.prompt(run, 'where are we?')
      const deadline = Date.now() + 10_000
      while (signals.filter((signal) => signal.type === 'idle').length < turn) {
        if (Date.now() > deadline) throw new Error(`turn ${turn} never ended`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const down = signals.flatMap((signal) =>
      signal.type === 'server_down' ? [`${signal.server} ${signal.why}`] : [],
    )
    expect(down).toEqual(['tade failed', 'tade failed'])
    // Said before the turn it begins, so whoever hears it knows the turn runs without.
    const order = signals.map((signal) => signal.type)
    expect(order.indexOf('server_down')).toBeLessThan(order.indexOf('turn_started'))
  }, 60_000)
})
