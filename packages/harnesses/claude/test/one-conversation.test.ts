import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import {
  type HubLink,
  OneConversation,
  SharedConversation,
  type WorkerSignal,
} from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeAnthropic, startFakeAnthropic } from '../../../../test/fixtures/fake-anthropic.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { sessionIdFor } from '../src/transcript.ts'

// The "heron" test (SHARED-BRAIN §2, P1), against the real claude here and a
// scripted model: told on the Mac, the Mac closed, asked on the hub — and the
// hub's Claude Code is sent what the Mac was told, in the same session, with
// nothing introduced twice. Two config folders and two working directories
// stand for two machines; the gate around each turn is the real one, joined
// in-process where the window would join it over SSH.

const TASK = 'tade/orchestrator-heron'
const MAC = { id: '11111111-1111-4111-8111-111111111111', name: 'mac' }
const VPS = { id: '22222222-2222-4222-8222-222222222222', name: 'vps' }

function installed(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function machine(me: { id: string; name: string }) {
  const account = tmp(`tade-claude-${me.name}-`)
  writeFileSync(`${account}/settings.json`, JSON.stringify({ apiKeyHelper: 'echo sk-fake' }))
  writeFileSync(`${account}/.claude.json`, JSON.stringify({ hasCompletedOnboarding: true }))
  const cwd = await realpath(tmp(`tade-claude-${me.name}-work-`))
  const adapter = new ClaudeAdapter({ runDir: tmp('tcc-heron-'), configDir: account })
  const replica = adapter.conversation
  const shared = new SharedConversation({
    home: tmp(`tade-claude-${me.name}-home-`),
    me,
    harness: adapter.id,
    format: replica.format,
    record: await replica.recordFor(TASK, cwd),
    take: (lines, leaf) => replica.take(TASK, cwd, lines, leaf),
  })
  return { adapter, cwd, shared, account }
}

describe.runIf(installed())(
  'one orchestrator conversation on two machines, with the real claude',
  () => {
    let model: FakeAnthropic | null = null
    const adapters: ClaudeAdapter[] = []
    afterEach(async () => {
      for (const one of adapters.splice(0)) await one.shutdown()
      await model?.close()
    })

    it('answers on the hub with what was told on the Mac, in the same session, after the Mac closed', async () => {
      model = await startFakeAnthropic({ finalText: 'Noted.' })
      const env = { ANTHROPIC_BASE_URL: model.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      const mac = await machine(MAC)
      const vps = await machine(VPS)
      adapters.push(mac.adapter, vps.adapter)
      const run = 'orchestrator'
      let vpsRunning = false

      const vpsGate = new OneConversation({
        shared: vps.shared,
        hub: () => null,
        reload: async () => {
          if (vpsRunning) await vps.adapter.conversation.reload(run)
        },
        say: () => {},
        warn: (text) => {
          throw new Error(text)
        },
        now: () => Date.now(),
        clock: () => '14:02',
      })
      let macUp = true
      const link: HubLink = {
        name: 'vps',
        get up() {
          return macUp
        },
        downSince: null,
        send: (ask) => vpsGate.answer(JSON.parse(JSON.stringify(ask))),
      }
      const macGate = new OneConversation({
        shared: mac.shared,
        hub: () => link,
        reload: async () => {},
        say: () => {},
        warn: (text) => {
          throw new Error(text)
        },
        now: () => Date.now(),
        clock: () => '14:02',
      })

      // On the Mac: a turn, between the gate's two halves.
      const macSignals: WorkerSignal[] = []
      mac.adapter.onSignal(run, (signal) => macSignals.push(signal))
      await macGate.before(true)
      await mac.adapter.start({ run, task: TASK, cwd: mac.cwd, prompt: '', env })
      await mac.adapter.prompt(run, 'remember the word heron')
      await until(() => macSignals.some((s) => s.type === 'idle'), { timeout: 60_000 })
      await macGate.after()
      // The Mac closes.
      await mac.adapter.shutdown()
      macUp = false

      // On the hub: a turn of its own, from what it already holds.
      await vpsGate.before(true)
      const vpsSignals: WorkerSignal[] = []
      vps.adapter.onSignal(run, (signal) => vpsSignals.push(signal))
      const before = model.requests.length
      await vps.adapter.start({ run, task: TASK, cwd: vps.cwd, prompt: '', env })
      vpsRunning = true
      await vps.adapter.prompt(run, 'what word did I say?')
      await until(() => vpsSignals.some((s) => s.type === 'idle'), { timeout: 60_000 })
      await vpsGate.after()

      const sent = model.requests
        .slice(before)
        .filter((request) => Array.isArray(request.tools) && request.tools.length > 0)
        .at(-1) as { messages?: { role: string; content: unknown }[] } | undefined
      const said = JSON.stringify(sent?.messages ?? [])
      // What the Mac was told, once, before what the hub was asked.
      expect(said.split('remember the word heron')).toHaveLength(2)
      expect(said.indexOf('remember the word heron')).toBeLessThan(
        said.indexOf('what word did I say?'),
      )
      // The same session, made from the task's name on both machines.
      const record = await vps.adapter.conversation.recordFor(TASK, vps.cwd)
      expect(basename(record)).toBe(`${sessionIdFor(TASK)}.jsonl`)
      expect(vpsSignals.find((s) => s.type === 'started')).toMatchObject({
        sessionId: sessionIdFor(TASK),
      })
      // Only one record of that conversation on the hub: it was carried on, not started over.
      const folders = readdirSync(`${vps.account}/projects`)
      expect(folders).toHaveLength(1)
    }, 180_000)
  },
)
