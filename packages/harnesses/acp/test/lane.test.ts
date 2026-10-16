import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TaskId } from '@tade/core'
import type { RunId, WorkerSignal, WorkerSpec } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AcpAdapter } from '../src/adapter.ts'
import type { AcpAgent } from '../src/agents.ts'
import type { LaneLaunch } from '../src/launch.ts'

// The whole of it, as Tade runs it: the adapter supervises a run, the lane
// program it hands back is started the way a driver would start it, and the
// lane drives the scripted ACP agent — so a signal here crossed the agent's
// stdio, the lane, the socket and the adapter, and a command went back down.

const SCRIPT = join(import.meta.dirname, 'scripted-agent.ts')
const SCRIPTED: AcpAgent = {
  id: 'scripted',
  title: 'Scripted',
  command: process.execPath,
  args: [SCRIPT],
  install: { instead: 'it is a test' },
}

/** This machine's environment without Tade's own: the suite may itself be run by a Tade agent. */
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('TADE_')),
)

const children: ChildProcess[] = []
const adapters: AcpAdapter[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGTERM')
  for (const one of adapters.splice(0)) await one.shutdown()
})

interface Setup {
  adapter: AcpAdapter
  spec: WorkerSpec
  signals: WorkerSignal[]
  log: string
  runDir: string
  launch(prompt?: string): ChildProcess
}

async function setup(approvals: 'bypass' | 'policy', caps = ''): Promise<Setup> {
  const runDir = tmp('tade-acp-lane-')
  const adapter = new AcpAdapter({
    runDir,
    socketDir: tmp('tacps-'),
    approvals,
    agents: [SCRIPTED],
  })
  adapters.push(adapter)
  const cwd = tmp('tade-acp-work-')
  const log = join(runDir, 'agent.log')
  const spec: WorkerSpec = {
    run: 'proj/fix/agent' as RunId,
    task: 'proj/fix' as TaskId,
    cwd,
    prompt: '',
    model: { provider: 'scripted', id: 'default' },
    extras: { instructions: 'You work inside Tade.' },
  }
  const signals: WorkerSignal[] = []
  adapter.onSignal(spec.run, (signal) => signals.push(signal))
  await adapter.supervise(spec)
  return {
    adapter,
    spec,
    signals,
    log,
    runDir,
    launch(prompt = '') {
      const line = adapter.launchSpec({ ...spec, prompt })
      const child = spawn(line.command, [...line.args, ...(line.opening ?? [])], {
        cwd,
        env: { ...ENV, ...line.env, ACP_SCRIPT_LOG: log, ACP_SCRIPT_CAPS: caps },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    },
  }
}

async function until(
  signals: WorkerSignal[],
  test: (signals: WorkerSignal[]) => boolean,
  ms = 15_000,
): Promise<void> {
  const start = Date.now()
  while (!test(signals)) {
    if (Date.now() - start > ms) {
      throw new Error(`never: ${JSON.stringify(signals.map((s) => s.type))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const count = (type: string) => (signals: WorkerSignal[]) =>
  signals.filter((s) => s.type === type).length
const any = (type: string) => (signals: WorkerSignal[]) => count(type)(signals) > 0

describe('an ACP agent in a lane', () => {
  it('says its opening instruction once, and reports the turn to Tade', async () => {
    const s = await setup('bypass')
    const lane = s.launch('say hello from the lane')
    let drawn = ''
    lane.stdout?.on('data', (chunk: Buffer) => {
      drawn += chunk.toString()
    })
    await until(s.signals, (all) => all.some((one) => one.type === 'message'))
    await until(s.signals, (all) => count('idle')(all) >= 2)
    expect(s.signals.find((one) => one.type === 'started')).toMatchObject({
      sessionId: 'sess-1',
      model: 'scripted/default',
    })
    expect(s.signals.find((one) => one.type === 'message')).toMatchObject({
      text: 'hello from the lane',
    })
    expect(await s.adapter.modelOf(s.spec.run)).toEqual({ provider: 'scripted', id: 'default' })
    // Drawn in the lane, the way the strip draws the orchestrator.
    await until(s.signals, () => drawn.includes('◆ hello from the lane'))
    expect(drawn).toContain('❯ say hello from the lane')
    // What Tade tells every agent went ahead of it.
    const prompts = readFileSync(s.log, 'utf8')
      .split('\n')
      .filter((line) => line.includes('session/prompt'))
    expect(prompts[0]).toContain('You work inside Tade.')
    expect(await s.adapter.hasConversation(s.spec.task, s.spec.cwd)).toBe(true)
    const page = await s.adapter.history(s.spec.task, s.spec.cwd, { limit: 10 })
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'reply'])
  })

  it('holds a command for Tade under policy, and runs it once Tade allows it', async () => {
    const s = await setup('policy')
    s.launch()
    await until(s.signals, any('idle'))
    await s.adapter.prompt(s.spec.run, 'run ls -la')
    await until(s.signals, (all) => all.some((one) => one.type === 'permission_request'))
    const ask = s.signals.find((one) => one.type === 'permission_request')
    expect(ask).toMatchObject({ tool: 'execute', summary: 'ls -la' })
    expect(s.adapter.effectOf('execute')).toBe('exec')
    if (ask?.type !== 'permission_request') throw new Error('no request')
    await s.adapter.decide(s.spec.run, ask.requestId, { allow: true })
    await until(s.signals, (all) => all.some((one) => one.type === 'tool_result'))
    expect(s.signals.find((one) => one.type === 'tool_result')).toMatchObject({ ok: true })
    // Answered once: a second decision for it is no decision.
    await expect(s.adapter.decide(s.spec.run, ask.requestId, { allow: true })).rejects.toThrow()
  })

  it('stops a turn from Tade, and the agent is still there after', async () => {
    const s = await setup('bypass')
    s.launch()
    await until(s.signals, any('idle'))
    await s.adapter.prompt(s.spec.run, 'slow')
    await until(s.signals, any('turn_started'))
    await s.adapter.abort(s.spec.run)
    await until(s.signals, (all) => all.some((one) => one.type === 'turn_done'))
    expect(s.signals.find((one) => one.type === 'turn_done')).toMatchObject({ status: 'aborted' })
  })

  it('comes back to the same conversation when the lane is started again', async () => {
    const s = await setup('bypass', 'resume')
    const first = s.launch('say one')
    await until(s.signals, (all) => count('idle')(all) >= 2)
    first.kill('SIGTERM')
    await new Promise((resolve) => first.once('exit', resolve))
    s.signals.length = 0
    s.launch()
    await until(s.signals, any('idle'))
    expect(s.signals.find((one) => one.type === 'started')).toMatchObject({ sessionId: 'sess-1' })
    expect(readFileSync(s.log, 'utf8')).toContain('"method":"session/resume"')
    // And nothing was said to it again on the way back.
    expect(readFileSync(s.log, 'utf8').split('session/prompt').length - 1).toBe(1)
  })

  it('refuses to move a conversation to another agent', async () => {
    const s = await setup('bypass')
    s.launch()
    await until(s.signals, any('idle'))
    await expect(s.adapter.setModel(s.spec.run, { provider: 'gemini', id: 'x' })).rejects.toThrow(
      /stays with the agent/,
    )
  })

  it('lends the agent Tade’s tools: the task said finished, and a tool run in Tade', async () => {
    const s = await setup('bypass')
    const lane = s.launch()
    await until(s.signals, any('idle'))
    const launch = JSON.parse(readFileSync(lane.spawnargs.at(-1) ?? '', 'utf8')) as LaneLaunch
    const tade = launch.mcpServers[0]
    if (!tade || 'type' in tade) throw new Error('no tools server')
    expect(tade.name).toBe('tade')
    const server = spawn(tade.command, tade.args, {
      env: { ...ENV, ...Object.fromEntries(tade.env.map((e) => [e.name, e.value])) },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    children.push(server)
    const answers = new Map<number, unknown>()
    createInterface({ input: server.stdout as NonNullable<typeof server.stdout> }).on(
      'line',
      (line) => {
        const message = JSON.parse(line) as { id: number; result: unknown }
        answers.set(message.id, message.result)
      },
    )
    const call = async (id: number, method: string, params: unknown) => {
      server.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      const start = Date.now()
      while (!answers.has(id)) {
        if (Date.now() - start > 10_000) throw new Error(`no answer to ${method}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return answers.get(id) as {
        tools?: { name: string }[]
        content?: { text: string }[]
        isError?: boolean
      }
    }
    await call(1, 'initialize', { protocolVersion: '2025-06-18' })
    const listed = await call(2, 'tools/list', {})
    expect(listed.tools?.map((tool) => tool.name)).toEqual([
      'tade_document_ready',
      'tade_leftovers',
      'tade_done',
    ])
    // Tade's own tools: asked of Tade, answered by it.
    s.adapter.onSignal(s.spec.run, (signal) => {
      if (signal.type === 'extension_call') {
        const text =
          signal.tool === 'tade_leftovers'
            ? 'What you left is put to the orchestrator.'
            : 'the document is read'
        void s.adapter.answer(s.spec.run, signal.callId, { ok: true, text })
      }
    })
    const left = [
      { title: 'a', where: 'src/a.ts:1', why: 'not mine', sure: 'certain' },
      { title: 'b', where: 'pnpm test', why: 'not mine', sure: 'likely' },
    ]
    const done = await call(3, 'tools/call', {
      name: 'tade_done',
      arguments: { summary: 'fixed it', leftovers: left },
    })
    expect(done.isError).toBe(false)
    expect(done.content?.[0]?.text).toBe(
      'Tade has it: this task is finished. What you left is put to the orchestrator.',
    )
    await until(s.signals, (all) => all.some((one) => one.type === 'done'))
    expect(s.signals.find((one) => one.type === 'done')).toMatchObject({ summary: 'fixed it' })
    // What it left went first, through the same door as `tade_leftovers`.
    const leftAt = s.signals.findIndex(
      (one) => one.type === 'extension_call' && one.tool === 'tade_leftovers',
    )
    expect(s.signals[leftAt]).toMatchObject({ input: { items: left, finishing: true } })
    expect(s.signals.findIndex((one) => one.type === 'done')).toBeGreaterThan(leftAt)
    const ready = await call(4, 'tools/call', {
      name: 'tade_document_ready',
      arguments: { ask: 'which?' },
    })
    expect(ready.content?.[0]?.text).toBe('the document is read')
  })
})
