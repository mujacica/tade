import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendixFor, mergeConversations, type WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'
import { PI_CONVERSATION, piRecordFor } from '../src/conversation.ts'

// pi's session read and written for one conversation on every machine, and —
// against the real pi and a scripted model — the evidence that a merge it is
// switched to between turns is what the model is sent next.

const TASK = 'tade/orchestrator-pi-test'

/** Waits on the thing being counted, never a fixed sleep. */
async function until(check: () => boolean, { timeout = 30_000 } = {}): Promise<void> {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function message(
  id: string,
  parent: string | null,
  role: string,
  text: string,
  at: string,
): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: parent,
    timestamp: at,
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp: Date.parse(at),
      // What pi writes on a reply of its own, and reads back on the next turn.
      ...(role === 'assistant'
        ? {
            api: 'openai-completions',
            provider: 'tade-test',
            model: 'fake',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
          }
        : {}),
    },
  })
}

function branches() {
  const shared = [
    message('a0000001', null, 'user', 'remember the word heron', '2026-11-23T10:00:00.000Z'),
    message('a0000002', 'a0000001', 'assistant', 'Noted: heron.', '2026-11-23T10:00:01.000Z'),
  ]
  return {
    mac: [
      ...shared,
      message('b0000001', 'a0000002', 'user', 'and the word wren', '2026-11-23T11:00:00.000Z'),
      message('b0000002', 'b0000001', 'assistant', 'Noted: wren.', '2026-11-23T11:00:01.000Z'),
    ],
    vps: [
      ...shared,
      message('c0000001', 'a0000002', 'user', 'and the word kestrel', '2026-11-23T12:00:00.000Z'),
      message('c0000002', 'c0000001', 'assistant', 'Noted: kestrel.', '2026-11-23T12:00:01.000Z'),
    ],
  }
}

describe("pi's session, for one conversation on every machine", () => {
  it('keeps its header here, reads its entries, and marks a merge as its own message', () => {
    expect(
      PI_CONVERSATION.read(JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/a' })),
    ).toEqual({ kind: 'kept' })
    const { mac, vps } = branches()
    expect(PI_CONVERSATION.read(mac[2] as string)).toMatchObject({
      kind: 'entry',
      id: 'b0000001',
      opens: true,
      message: true,
    })
    expect(
      PI_CONVERSATION.read(
        JSON.stringify({
          type: 'model_change',
          id: 'm',
          parentId: null,
          timestamp: 't',
          provider: 'p',
          modelId: 'x',
        }),
      ),
    ).toMatchObject({ message: false })
    expect(
      PI_CONVERSATION.read(JSON.stringify({ type: 'teleport', id: 'm', parentId: null })),
    ).toEqual({ kind: 'unknown', why: 'an entry of type teleport' })
    const merged = mergeConversations(
      PI_CONVERSATION,
      { name: 'mac', lines: mac },
      { name: 'vps', lines: vps },
    )
    if (!merged.ok || !merged.fork) throw new Error('expected a fork')
    const marker = JSON.parse(merged.lines.find((line) => line.includes('tade-merge')) ?? '{}')
    expect(marker).toMatchObject({
      type: 'custom_message',
      customType: 'tade-merge',
      display: true,
      parentId: 'b0000002',
    })
    expect(merged.fork.leaf).toMatch(/^[0-9a-f]{8}$/)
  })

  describe('against the pi here', () => {
    let model: FakeModel | null = null
    let adapter: PiAdapter | null = null
    afterEach(async () => {
      await adapter?.shutdown()
      await model?.close()
    })

    it('comes back to the end of a merge, and reads its session again on switch_session', async () => {
      model = await startFakeModel({ finalText: 'heron, wren and kestrel' })
      const runDir = tmp('tade-pi-merge-')
      const cwd = tmp('tade-pi-merge-work-')
      adapter = new PiAdapter({
        runDir,
        socketDir: tmp('pm-'),
        supervise: false,
        args: ['-e', writeProviderExtension(runDir)],
        env: { ...process.env, TADE_TEST_BASE_URL: model.url },
      })
      const replica = adapter.conversation
      const { mac, vps } = branches()
      await replica.take(TASK, cwd, mac, null)
      const merged = mergeConversations(
        PI_CONVERSATION,
        { name: 'mac', lines: mac },
        { name: 'vps', lines: vps },
      )
      if (!merged.ok || !merged.fork) throw new Error('expected a fork')
      await replica.take(
        TASK,
        cwd,
        appendixFor(PI_CONVERSATION, mac, merged.lines),
        merged.fork.leaf,
      )
      const record = await piRecordFor(TASK, join(runDir, 'sessions'))
      expect(readFileSync(record, 'utf8').split('\n')[0]).toContain('"type":"session"')

      const signals: WorkerSignal[] = []
      adapter.onSignal('o', (signal) => signals.push(signal))
      await adapter.start({
        run: 'o',
        task: TASK,
        cwd,
        prompt: '',
        model: { provider: 'tade-test', id: 'fake' },
      })
      await adapter.prompt('o', 'which words?')
      await until(
        () => signals.some((s) => s.type === 'idle') && (model?.requests.length ?? 0) >= 1,
        { timeout: 60_000 },
      ).catch((err) => {
        throw new Error(
          `${(err as Error).message}: ${JSON.stringify(signals)} ${model?.requests.length}`,
        )
      })
      const sent = JSON.stringify(model.requests.at(-1))
      const order = [
        'heron',
        'wren',
        '[Tade] While mac and vps could not reach each other',
        'kestrel',
        'which words?',
      ]
      const at = order.map((word) => sent.indexOf(word))
      expect(at.every((n) => n >= 0)).toBe(true)
      expect([...at].sort((x, y) => x - y)).toEqual(at)

      // Another machine's turn, taken between turns and read again.
      const lines = readFileSync(record, 'utf8').trim().split('\n')
      const tip = JSON.parse(lines.at(-1) ?? '{}').id as string
      await replica.take(
        TASK,
        cwd,
        [
          message('d0000001', tip, 'user', 'and the word plover', '2026-11-23T13:00:00.000Z'),
          message(
            'd0000002',
            'd0000001',
            'assistant',
            'Noted: plover.',
            '2026-11-23T13:00:01.000Z',
          ),
        ],
        'd0000002',
      )
      await replica.reload('o')
      const before = model.requests.length
      signals.length = 0
      await adapter.prompt('o', 'and now?')
      await until(
        () => signals.some((s) => s.type === 'idle') && (model?.requests.length ?? 0) > before,
        { timeout: 60_000 },
      )
      expect(JSON.stringify(model.requests.at(-1))).toContain('plover')
    }, 120_000)
  })
})
