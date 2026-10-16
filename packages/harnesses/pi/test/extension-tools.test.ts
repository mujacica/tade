import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSignal } from '@tade/harnesses-core'
import { LEFTOVER_ITEMS, LEFTOVERS_TOOL } from '@tade/harnesses-core/agent-tools'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'
import * as leftovers from '../src/leftovers.ts'
import { readTools } from '../src/tade.ts'

// An agent calling one of Tade's extension tools, proven against a real pi
// with a scripted model: pi registers the tool from the list it was launched
// with, the call comes back to Tade over the supervision channel, and what
// Tade answers is what the model is told.

async function until(check: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

describe('extension tools in an agent', () => {
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
  })

  it('runs in Tade, and the model is told what Tade answered', async () => {
    const runDir = tmp('tade-ext-tools-')
    const tools = join(runDir, 'tools.json')
    writeFileSync(
      tools,
      JSON.stringify([
        {
          name: 'sentry_issue',
          label: 'Sentry: issue',
          description: 'Everything Sentry knows about one issue.',
          parameters: {
            type: 'object',
            properties: { issue: { type: 'string' } },
            required: ['issue'],
          },
        },
      ]),
    )
    model = await startFakeModel({
      tool: { name: 'sentry_issue', arguments: { issue: 'SHOP-1A' } },
      finalText: 'It is the order lookup.',
    })
    adapter = new PiAdapter({
      runDir,
      // A socket path over ~104 bytes will not bind, and tmp dirs are long.
      socketDir: tmp('wx-'),
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('fix', (signal) => {
      signals.push(signal)
      if (signal.type === 'extension_call') {
        void adapter?.answer('fix', signal.callId, {
          ok: true,
          text: '# SHOP-1A: TypeError in refund (src/refunds.ts:42)',
        })
      }
    })
    await adapter.start({
      run: 'fix',
      task: 'shop/fix',
      cwd: tmp('tade-ext-tools-work-'),
      prompt: 'look at SHOP-1A',
      model: { provider: 'tade-test', id: 'fake' },
      extras: { tools, instructions: 'Errors from shop go to Sentry.' },
    })

    await until(() => signals.some((signal) => signal.type === 'extension_call'))
    expect(signals.find((signal) => signal.type === 'extension_call')).toMatchObject({
      tool: 'sentry_issue',
      input: { issue: 'SHOP-1A' },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    const told = JSON.stringify(model.requests[1])
    expect(told).toContain('TypeError in refund (src/refunds.ts:42)')
    // And it was told about the extensions before it started.
    expect(JSON.stringify(model.requests[0])).toContain('Errors from shop go to Sentry.')
  }, 90_000)

  it('says when its task is finished, in the words the agent used', async () => {
    const runDir = tmp('tade-done-')
    model = await startFakeModel({
      tool: { name: 'tade_done', arguments: { summary: 'Refunds charge once, with a test.' } },
      finalText: 'Finished.',
    })
    adapter = new PiAdapter({
      runDir,
      socketDir: tmp('wd-'),
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('done', (signal) => signals.push(signal))
    await adapter.start({
      run: 'done',
      task: 'shop/refunds',
      cwd: tmp('tade-done-work-'),
      prompt: 'fix the double charge',
      model: { provider: 'tade-test', id: 'fake' },
    })
    await until(() => signals.some((signal) => signal.type === 'done'))
    expect(signals.find((signal) => signal.type === 'done')).toMatchObject({
      summary: 'Refunds charge once, with a test.',
    })
  }, 90_000)

  it('hands its document over through Tade, and is told why when Tade refuses', async () => {
    // Tade's own tool, registered whether or not any extension lent one, and
    // answered the way an extension's is: a refusal is a failed call it reads.
    const runDir = tmp('tade-ready-')
    model = await startFakeModel({
      tool: { name: 'tade_document_ready', arguments: { ask: 'A or B?' } },
      finalText: 'Waiting.',
    })
    adapter = new PiAdapter({
      runDir,
      socketDir: tmp('wr-'),
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('ready', (signal) => {
      signals.push(signal)
      if (signal.type === 'extension_call') {
        void adapter?.answer('ready', signal.callId, {
          ok: false,
          text: 'nothing readable is at /h/plan.md yet',
        })
      }
    })
    await adapter.start({
      run: 'ready',
      task: 'shop/plan',
      cwd: tmp('tade-ready-work-'),
      prompt: 'plan the refunds work',
      model: { provider: 'tade-test', id: 'fake' },
    })
    await until(() => signals.some((signal) => signal.type === 'extension_call'))
    expect(signals.find((signal) => signal.type === 'extension_call')).toMatchObject({
      tool: 'tade_document_ready',
      input: { ask: 'A or B?' },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(JSON.stringify(model.requests[1])).toContain('nothing readable is at /h/plan.md yet')
  }, 90_000)

  /** An agent whose model finishes with two things it left, answered by `answer`. */
  const finishing = async (answer: { ok: boolean; text: string }) => {
    const runDir = tmp('tade-left-')
    const left = [
      {
        title: 'bind: lan refuses the phone’s own address',
        where: 'packages/web/src/listeners.ts:88',
        why: 'outside this task',
        sure: 'certain',
      },
      {
        title: 'the away cookie is never renewed',
        where: 'packages/web/src/session.ts',
        why: 'needs a decision about sessions',
        sure: 'likely',
      },
    ]
    model = await startFakeModel({
      tool: { name: 'tade_done', arguments: { summary: 'The socket decides.', leftovers: left } },
      finalText: 'Finished.',
    })
    adapter = new PiAdapter({
      runDir,
      socketDir: tmp('wl-'),
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('left', (signal) => {
      signals.push(signal)
      if (signal.type === 'extension_call') void adapter?.answer('left', signal.callId, answer)
    })
    await adapter.start({
      run: 'left',
      task: 'tade/remote',
      cwd: tmp('tade-left-work-'),
      prompt: 'make the socket decide',
      model: { provider: 'tade-test', id: 'fake' },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    return { signals, left, told: JSON.stringify(model.requests[1]) }
  }

  it('reports the two things it left before it says it is done', async () => {
    const { signals, left, told } = await finishing({
      ok: true,
      text: 'What you left is put to the orchestrator as tade/a and tade/b.',
    })
    // Through Tade's door, as `tade_leftovers`, and only then finished.
    const call = signals.findIndex((signal) => signal.type === 'extension_call')
    expect(signals[call]).toMatchObject({
      tool: 'tade_leftovers',
      input: { items: left, finishing: true },
    })
    await until(() => signals.some((signal) => signal.type === 'done'))
    expect(signals.findIndex((signal) => signal.type === 'done')).toBeGreaterThan(call)
    expect(signals.find((signal) => signal.type === 'done')).toMatchObject({
      summary: 'The socket decides.',
    })
    expect(told).toContain(
      'Tade has it: this task is finished. What you left is put to the orchestrator as tade/a and tade/b.',
    )
  }, 90_000)

  it('is not finished when Tade refuses what it left, and is told why', async () => {
    const { signals, told } = await finishing({ ok: false, text: 'item 2 has no where' })
    expect(told).toContain(
      'Nothing is finished yet: what you left was not taken. item 2 has no where',
    )
    expect(signals.some((signal) => signal.type === 'done')).toBe(false)
  }, 90_000)

  it('keeps its copy of what an agent may report word for word with every other harness’s', () => {
    // pi may import nothing of Tade's, so it has a copy; this is what holds it.
    expect(leftovers.LEFTOVER_ITEMS).toEqual(LEFTOVER_ITEMS)
    const { label, ...tool } = leftovers.LEFTOVERS_TOOL
    expect(label).toBe('Leftovers')
    expect(tool).toEqual(LEFTOVERS_TOOL)
  })

  it('lists no tools from a list that is missing or not a list', () => {
    expect(readTools(undefined)).toEqual([])
    expect(readTools('/nonexistent/tools.json')).toEqual([])
    const path = join(tmp('tade-ext-tools-'), 'bad.json')
    writeFileSync(path, '{"name":"x"}')
    expect(readTools(path)).toEqual([])
  })
})
