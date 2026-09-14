import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSignal } from '@wilco/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'
import { readTools } from '../src/wilco.ts'

// An agent calling one of Wilco's extension tools, proven against a real pi
// with a scripted model: pi registers the tool from the list it was launched
// with, the call comes back to Wilco over the supervision channel, and what
// Wilco answers is what the model is told.

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

  it('runs in Wilco, and the model is told what Wilco answered', async () => {
    const runDir = tmp('wilco-ext-tools-')
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
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
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
      cwd: tmp('wilco-ext-tools-work-'),
      prompt: 'look at SHOP-1A',
      model: { provider: 'wilco-test', id: 'fake' },
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
    const runDir = tmp('wilco-done-')
    model = await startFakeModel({
      tool: { name: 'wilco_done', arguments: { summary: 'Refunds charge once, with a test.' } },
      finalText: 'Finished.',
    })
    adapter = new PiAdapter({
      runDir,
      socketDir: tmp('wd-'),
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('done', (signal) => signals.push(signal))
    await adapter.start({
      run: 'done',
      task: 'shop/refunds',
      cwd: tmp('wilco-done-work-'),
      prompt: 'fix the double charge',
      model: { provider: 'wilco-test', id: 'fake' },
    })
    await until(() => signals.some((signal) => signal.type === 'done'))
    expect(signals.find((signal) => signal.type === 'done')).toMatchObject({
      summary: 'Refunds charge once, with a test.',
    })
  }, 90_000)

  it('lists no tools from a list that is missing or not a list', () => {
    expect(readTools(undefined)).toEqual([])
    expect(readTools('/nonexistent/tools.json')).toEqual([])
    const path = join(tmp('wilco-ext-tools-'), 'bad.json')
    writeFileSync(path, '{"name":"x"}')
    expect(readTools(path)).toEqual([])
  })
})
