import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import {
  PermissionNotPendingError,
  type RunId,
  SignalChannel,
  type WorkerCommand,
  type WorkerSpec,
} from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AcpAdapter, contextFor, runSocket, serversIn } from '../src/adapter.ts'
import { ACP_AGENTS, type AcpAgent, agentNamed, programsOf } from '../src/agents.ts'
import { chooseAgent, type LaneLaunch, onPath, readLaunch } from '../src/launch.ts'
import { Link } from '../src/link.ts'

// The adapter's answers that need no agent running: what it finds on this
// machine, what it is told to run on, what it hands the lane, and what it
// refuses — each in words.

/** A folder on PATH holding a program that says its version, and nothing else. */
function pathWith(...names: string[]): string {
  const dir = tmp('tade-acp-bin-')
  for (const name of names) {
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\necho "${name} 1.2.3"\n`)
    chmodSync(file, 0o755)
  }
  return dir
}

const adapters: AcpAdapter[] = []
const links: Link[] = []
afterEach(async () => {
  for (const one of links.splice(0)) one.close()
  for (const one of adapters.splice(0)) await one.shutdown()
})

function adapter(env: NodeJS.ProcessEnv = { PATH: pathWith() }, approvals?: 'policy'): AcpAdapter {
  const one = new AcpAdapter({
    runDir: tmp('tade-acp-run-'),
    socketDir: tmp('tacpa-'),
    env,
    ...(approvals ? { approvals } : {}),
  })
  adapters.push(one)
  return one
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  run: 'proj/t/agent' as RunId,
  task: 'proj/t' as TaskId,
  cwd: tmp('tade-acp-cwd-'),
  prompt: '',
  ...over,
})

describe('the agents it drives', () => {
  it('declares each as a program it may use, any one of them, installing none', () => {
    const programs = programsOf(ACP_AGENTS)
    expect(programs.map((one) => one.command)).toEqual([
      'gemini',
      'opencode',
      'goose',
      'copilot',
      'kiro-cli',
      'cursor-agent',
      'qwen',
    ])
    expect(programs.every((one) => one.optional === true)).toBe(true)
    // An install command only where the registry names the package.
    expect(programs.find((one) => one.command === 'gemini')?.install).toEqual({
      npm: '@google/gemini-cli',
    })
    expect(programs.find((one) => one.command === 'goose')?.install?.npm).toBeUndefined()
  })

  it('finds one by its id, its name or its program', () => {
    expect(agentNamed(ACP_AGENTS, 'Gemini CLI')?.id).toBe('gemini')
    expect(agentNamed(ACP_AGENTS, 'copilot')?.id).toBe('github-copilot-cli')
    expect(agentNamed(ACP_AGENTS, ' opencode ')?.id).toBe('opencode')
    expect(agentNamed(ACP_AGENTS, '')).toBeNull()
    expect(agentNamed(ACP_AGENTS, 'nobody')).toBeNull()
  })
})

describe('what is on this machine', () => {
  it('can run when any one agent is here, and says which and at what version', async () => {
    const one = adapter({ PATH: pathWith('goose', 'qwen') })
    const probe = await one.probe()
    expect(probe).toEqual({ ok: true, version: 'goose 1.2.3, qwen-code 1.2.3', problems: [] })
    expect((await one.models()).map((model) => model.id)).toEqual([
      'goose/default',
      'qwen-code/default',
    ])
  })

  it('says none is installed, naming them, when none is', async () => {
    const probe = await adapter().probe()
    expect(probe.ok).toBe(false)
    expect(probe.problems[0]).toContain('gemini, opencode, goose')
    expect(await adapter().models()).toEqual([])
  })

  it('places an agent, and a model within it, named the way people say them', async () => {
    const one = adapter()
    expect(await one.resolveModel('gemini')).toEqual({
      ok: true,
      provider: 'gemini',
      id: 'default',
    })
    expect(await one.resolveModel('OpenCode/anthropic/claude-sonnet-5')).toEqual({
      ok: true,
      provider: 'opencode',
      id: 'anthropic/claude-sonnet-5',
    })
    expect(await one.resolveModel('goose/')).toEqual({ ok: true, provider: 'goose', id: 'default' })
    const unknown = await one.resolveModel('gpt-9')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('gemini')
  })

  it('judges a tool by the kind ACP gives it, and nothing else', () => {
    const one = adapter()
    expect(['read', 'search', 'think'].map((tool) => one.effectOf(tool))).toEqual([
      'read',
      'read',
      'read',
    ])
    expect(['edit', 'delete', 'move'].map((tool) => one.effectOf(tool))).toEqual([
      'write',
      'write',
      'write',
    ])
    expect(one.effectOf('execute')).toBe('exec')
    expect(one.effectOf('fetch')).toBe('other')
  })

  it('is signed in as nobody, and says the agent signs itself in', async () => {
    const one = adapter()
    expect((await one.account()).problem).toContain('own sign-in')
    expect(one.signIn()).toBeNull()
    expect(one.limits()).toBeNull()
    await expect(one.signOut()).rejects.toThrow(/own way/)
    await expect(one.carryConversation('proj/t' as TaskId, '', one)).resolves.toBe(false)
    await expect(one.start(spec())).rejects.toThrow(/runs only in a lane/)
  })
})

describe('what the lane is handed', () => {
  it('names the agent and model asked for, and what Tade tells every agent', () => {
    const one = adapter()
    const told = spec({
      model: { provider: 'opencode', id: 'anthropic/claude-sonnet-5' },
      extras: { instructions: 'You work inside Tade.', skills: ['/skills/ship-it/'] },
    })
    const line = one.launchSpec(told)
    const launch = readLaunch(line.args[1] ?? '')
    expect(launch.agent).toBe('opencode')
    expect(launch.model).toBe('anthropic/claude-sonnet-5')
    expect(launch.instructions).toContain('You work inside Tade.')
    expect(launch.instructions).toContain('ship-it (read /skills/ship-it/SKILL.md)')
    expect(launch.mcpServers[0]).toMatchObject({ name: 'tade', command: process.execPath })
    expect(launch.record).toContain(join('acp', 'acp-'))
  })

  it('leaves the choice of agent to the lane when none was asked for', () => {
    const launch = readLaunch(
      adapter().launchSpec(spec({ model: { id: 'default' } })).args[1] ?? '',
    )
    expect(launch.agent).toBeNull()
    expect(launch.model).toBeNull()
  })

  it('shows a picture as a file it is told about', () => {
    const line = adapter().launchSpec(
      spec({
        prompt: 'look at this',
        images: [{ data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }],
      }),
    )
    const said = line.opening?.[0] ?? ''
    expect(said).toMatch(/^look at this\n\n\[picture: .+\.png\]$/)
    const path = /\[picture: (.+)\]/.exec(said)?.[1] ?? ''
    expect(readFileSync(path, 'utf8')).toBe('png')
  })

  it('passes on the MCP servers extensions gave it, in ACP’s words', () => {
    const dir = tmp('tade-acp-mcp-')
    const file = join(dir, 'servers.json')
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          tade: { command: 'shadow' },
          local: { command: 'srv', args: ['--stdio', 3], env: { TOKEN: 'x', N: 1 } },
          remote: { url: 'https://mcp.example', headers: { Authorization: 'Bearer y' } },
          odd: { socket: '/tmp/s' },
        },
      }),
    )
    const warned: string[] = []
    expect(serversIn(file, (message) => warned.push(message))).toEqual([
      { name: 'tade', command: 'shadow', args: [], env: [] },
      {
        name: 'local',
        command: 'srv',
        args: ['--stdio', '3'],
        env: [{ name: 'TOKEN', value: 'x' }],
      },
      {
        type: 'http',
        name: 'remote',
        url: 'https://mcp.example',
        headers: [{ name: 'Authorization', value: 'Bearer y' }],
      },
    ])
    expect(warned[0]).toContain('odd')
    expect(serversIn(join(dir, 'missing.json'), (message) => warned.push(message))).toEqual([])
    expect(warned[1]).toContain('could not read')
    // Tade's own is Tade's: an extension's server of the same name never replaces it.
    const launch = readLaunch(adapter().launchSpec(spec({ extras: { mcp: [file] } })).args[1] ?? '')
    expect(launch.mcpServers.map((one) => one.name)).toEqual(['tade', 'local', 'remote'])
    expect(launch.mcpServers[0]).toMatchObject({ command: process.execPath })
  })

  it('says nothing about skills where it has none', () => {
    expect(contextFor(spec())).toBe('')
  })
})

describe('which agent a lane runs', () => {
  const agents: AcpAgent[] = ACP_AGENTS.slice(0, 3)

  it('stays with the agent its conversation is in, and says so when asked for another', () => {
    const chosen = chooseAgent({ agent: 'gemini', agents }, 'opencode')
    expect(chosen.agent?.id).toBe('opencode')
    expect(chosen.why).toContain('stays there rather than moving to gemini')
    expect(chooseAgent({ agent: null, agents }, 'opencode').why).toBeNull()
  })

  it('runs the one asked for, and refuses one it does not drive', () => {
    expect(chooseAgent({ agent: 'goose', agents }, null)).toEqual({ agent: agents[2], why: null })
    expect(chooseAgent({ agent: 'nobody', agents }, null)).toEqual({
      agent: null,
      why: 'no agent called nobody is configured for the acp harness',
    })
  })

  it('runs the first one here when none was asked for, and says when none is', () => {
    const chosen = chooseAgent({ agent: null, agents }, null, pathWith('goose'))
    expect(chosen.agent?.id).toBe('goose')
    expect(chosen.why).toContain('the first one here')
    const none = chooseAgent({ agent: null, agents }, null, pathWith())
    expect(none.agent).toBeNull()
    expect(none.why).toContain('gemini, opencode, goose')
  })

  it('finds a program on the PATH, or by its own path', () => {
    const dir = pathWith('gemini')
    expect(onPath('gemini', `/nowhere:${dir}`)).toBe(join(dir, 'gemini'))
    expect(onPath('gemini', '')).toBeNull()
    expect(onPath(join(dir, 'gemini'))).toBe(join(dir, 'gemini'))
    expect(onPath(join(dir, 'nothing'))).toBeNull()
  })

  it('refuses a launch file it did not write', () => {
    const file = join(tmp('tade-acp-launch-'), 'launch.json')
    writeFileSync(file, '{"agent":"gemini"}')
    expect(() => readLaunch(file)).toThrow(/not a launch Tade wrote/)
    const minimal: Partial<LaneLaunch> = { record: '/r.jsonl', agents: [] }
    writeFileSync(file, JSON.stringify(minimal))
    expect(readLaunch(file)).toEqual({
      record: '/r.jsonl',
      agent: null,
      model: null,
      agents: [],
      instructions: '',
      mcpServers: [],
    })
  })
})

describe('the run, as Tade holds it', () => {
  it('refuses what ACP cannot do, in the harness’s own words', async () => {
    const one = adapter()
    const told = spec()
    await one.supervise(told)
    await expect(one.setThinking(told.run, 'high')).rejects.toThrow(/each names its own levels/)
    await expect(one.name(told.run, 'x')).rejects.toThrow(/cannot rename/)
    await expect(one.compact(told.run)).rejects.toThrow(/leaves compacting/)
    // Nothing connected yet: nothing can be said to it, and that is said.
    await expect(one.prompt(told.run, 'hello')).rejects.toThrow(/not connected to Tade yet/)
    await expect(one.decide(told.run, 'r1', { allow: true })).rejects.toBeInstanceOf(
      PermissionNotPendingError,
    )
    expect(await one.modelOf(told.run)).toBeNull()
    await one.stop(told.run)
    expect(await one.list()).toEqual([])
    await one.stop(told.run)
  })

  it('carries signals up and commands down the lane’s socket, and dials again after a drop', async () => {
    const one = adapter(undefined, 'policy')
    const told = spec({ model: { provider: 'gemini', id: 'default' } })
    await one.supervise(told)
    const signals: string[] = []
    one.onSignal(told.run, (signal) => signals.push(signal.type))
    const commands: WorkerCommand[] = []
    let connects = 0
    const link = new Link({
      path: runSocket((one as unknown as { opts: { socketDir: string } }).opts.socketDir, told.run),
      onCommand: (command) => commands.push(command),
      onConnect: () => connects++,
      onDisconnect: () => {},
    })
    links.push(link)
    await waitFor(() => link.connected)
    link.send({ type: 'started', run: told.run, at: 1, sessionId: 's', model: 'gemini/flash' })
    link.send({
      type: 'permission_request',
      run: told.run,
      at: 2,
      requestId: 'r1',
      tool: 'execute',
      input: {},
      summary: 'ls',
    })
    await waitFor(() => signals.length === 2)
    expect(await one.modelOf(told.run)).toEqual({ provider: 'gemini', id: 'flash' })
    expect((await one.list())[0]?.sessionId).toBe('s')
    await one.decide(told.run, 'r1', { allow: false, reason: 'no' })
    await one.queue(told.run, 'next')
    await one.steer(told.run, 'now')
    await one.abort(told.run)
    await one.setModel(told.run, { provider: 'gemini', id: 'pro' })
    await one.answer(told.run, 'c1', { ok: true, text: 'yes' })
    await waitFor(() => commands.length === 6)
    expect(commands.map((command) => command.type)).toEqual([
      'decision',
      'queue',
      'steer',
      'abort',
      'model',
      'extension_result',
    ])
    await expect(one.setModel(told.run, { provider: 'goose', id: 'x' })).rejects.toThrow(
      /stays with/,
    )
    // The window closes and opens again: the lane finds it where it was.
    await one.detach()
    await one.supervise(told)
    await waitFor(() => connects === 2, 8_000)
    await one.shutdown()
    await waitFor(() => commands.some((command) => command.type === 'shutdown'))
  })
})

describe('Tade’s side of the socket', () => {
  it('takes a signal it can read and skips one it cannot', async () => {
    const dir = tmp('tacpc-')
    mkdirSync(dir, { recursive: true })
    const got: string[] = []
    const warned: string[] = []
    const channel = await SignalChannel.listen({
      path: join(dir, 's.sock'),
      run: 'r',
      onSignal: (signal) => got.push(signal.type),
      onWarning: (message) => warned.push(message),
    })
    const link = new Link({
      path: join(dir, 's.sock'),
      onCommand: () => {},
      onConnect: () => {},
      onDisconnect: () => {},
    })
    links.push(link)
    await waitFor(() => link.connected)
    link.send({ type: 'nonsense', run: 'r', at: 1 })
    link.send({ type: 'idle', run: 'r', at: 1 })
    await waitFor(() => got.length === 1)
    expect(warned[0]).toContain('unrecognised signal')
    await channel.close()
  })
})

async function waitFor(test: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!test()) {
    if (Date.now() - start > ms) throw new Error('it never happened')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
