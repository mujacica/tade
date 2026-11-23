import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { until } from '@tade/drivers-core/conformance'
import type { WorkerSignal } from '@tade/harnesses-core'
import { appendixFor, mergeConversations } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeAnthropic, startFakeAnthropic } from '../../../../test/fixtures/fake-anthropic.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { ClaudeAdapter } from '../src/adapter.ts'
import { CLAUDE_CONVERSATION } from '../src/conversation.ts'
import { sessionIdFor } from '../src/transcript.ts'

// Claude Code's record read and written for one conversation on every
// machine, and — against the real `claude` here and a scripted model — the
// evidence that `--resume` comes back to the end of a merge and sends the
// model both sides of it. Its format is private, so that is pinned to the
// version that runs here; when Claude Code moves forward this is what says
// whether it still holds.

const TASK = 'tade/orchestrator-test'
const SESSION = sessionIdFor(TASK)

/** A line as Claude Code writes one: keys in its order, `cwd` after the message. */
function user(id: string, parent: string | null, text: string, at: string, cwd: string): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: id,
    timestamp: at,
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd,
    sessionId: SESSION,
    version: '2.1.311',
  })
}

function reply(id: string, parent: string, text: string, at: string, cwd: string): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    message: {
      id: `msg_${id.slice(-8)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fake',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    type: 'assistant',
    uuid: id,
    timestamp: at,
    userType: 'external',
    cwd,
    sessionId: SESSION,
    version: '2.1.311',
  })
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Both had the heron; then the Mac heard about a wren and the VPS about a kestrel. */
function branches(mac: string, vps: string) {
  const shared = (cwd: string) => [
    user(id(1), null, 'remember the word heron', '2026-11-23T10:00:00.000Z', cwd),
    reply(id(2), id(1), 'Noted: heron.', '2026-11-23T10:00:01.000Z', cwd),
  ]
  return {
    mac: [
      ...shared(mac),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'x', leafUuid: id(2), sessionId: SESSION }),
      user(id(3), id(2), 'and the word wren', '2026-11-23T11:00:00.000Z', mac),
      reply(id(4), id(3), 'Noted: wren.', '2026-11-23T11:00:01.000Z', mac),
    ],
    vps: [
      ...shared(vps),
      user(id(5), id(2), 'and the word kestrel', '2026-11-23T12:00:00.000Z', vps),
      reply(id(6), id(5), 'Noted: kestrel.', '2026-11-23T12:00:01.000Z', vps),
    ],
  }
}

const canonical = (lines: readonly string[]) =>
  lines.flatMap((line) => {
    const read = CLAUDE_CONVERSATION.read(line)
    return read.kind === 'entry' ? [read.text] : []
  })

describe("Claude Code's record, for one conversation on every machine", () => {
  it('reads entries and bookkeeping, and blanks only the working directory', () => {
    const line = user(id(1), null, 'hi', '2026-11-23T10:00:00.000Z', '/Users/me/tade')
    const read = CLAUDE_CONVERSATION.read(line)
    expect(read).toMatchObject({
      kind: 'entry',
      id: id(1),
      parent: null,
      message: true,
      opens: true,
    })
    if (read.kind !== 'entry') return
    expect(read.text).toBe(line.replace('"cwd":"/Users/me/tade"', '"cwd":""'))
    expect(CLAUDE_CONVERSATION.localised(read.text, { cwd: '/srv/tade' })).toBe(
      line.replace('/Users/me/tade', '/srv/tade'),
    )
    for (const kept of ['last-prompt', 'api-request', 'cost-state', 'mode', 'queue-operation']) {
      expect(CLAUDE_CONVERSATION.read(JSON.stringify({ type: kept, sessionId: SESSION }))).toEqual({
        kind: 'kept',
      })
    }
  })

  it('knows a tool answer is not words said to it, and a meta line is not a message', () => {
    const answer = JSON.stringify({
      parentUuid: id(1),
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
      },
      uuid: id(2),
      timestamp: 'x',
      cwd: '/a',
    })
    expect(CLAUDE_CONVERSATION.read(answer)).toMatchObject({ message: true, opens: false })
    const meta = JSON.stringify({
      parentUuid: null,
      type: 'user',
      isMeta: true,
      message: { content: 'c' },
      uuid: id(3),
    })
    expect(CLAUDE_CONVERSATION.read(meta)).toMatchObject({ message: false })
  })

  it('does not guess at a shape it does not know', () => {
    expect(CLAUDE_CONVERSATION.read(JSON.stringify({ type: 'hologram', sessionId: 's' }))).toEqual({
      kind: 'unknown',
      why: 'a line of type hologram with no uuid',
    })
    expect(
      CLAUDE_CONVERSATION.read(JSON.stringify({ type: 'dream', uuid: 'u', parentUuid: null })),
    ).toEqual({
      kind: 'unknown',
      why: 'an entry of type dream',
    })
    // Not what writing it back gives: a copy would not be byte for byte.
    expect(CLAUDE_CONVERSATION.read('{"type": "user", "uuid": "u"}')).toMatchObject({
      kind: 'unknown',
    })
  })

  it('merges two machines to the same lines, whatever each calls its folder', () => {
    const { mac, vps } = branches('/Users/me/tade', '/srv/tade')
    const one = mergeConversations(
      CLAUDE_CONVERSATION,
      { name: 'mac', lines: mac },
      { name: 'vps', lines: vps },
    )
    const other = mergeConversations(
      CLAUDE_CONVERSATION,
      { name: 'vps', lines: vps },
      { name: 'mac', lines: mac },
    )
    if (!one.ok || !other.ok) throw new Error('expected a merge')
    expect(one.lines).toEqual(other.lines)
    expect(one.fork).toMatchObject({ trunk: 'mac', other: 'vps', copied: 1, left: 0 })
    // Ids derived from the originals, shaped like its own.
    expect(one.fork?.leaf).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  describe.runIf(installed())('against the claude here', () => {
    let model: FakeAnthropic | null = null
    let adapter: ClaudeAdapter | null = null
    afterEach(async () => {
      await adapter?.shutdown()
      await model?.close()
    })

    it('comes back to the end of a merge, sends the model both sides, and reads a take again on reload', async () => {
      model = await startFakeAnthropic({ finalText: 'heron, wren and kestrel' })
      const account = tmp('tade-claude-merge-')
      writeFileSync(`${account}/settings.json`, JSON.stringify({ apiKeyHelper: 'echo sk-fake' }))
      writeFileSync(`${account}/.claude.json`, JSON.stringify({ hasCompletedOnboarding: true }))
      const cwd = await realpath(tmp('tade-claude-merge-work-'))
      const one = new ClaudeAdapter({ runDir: tmp('tcc-merge-'), configDir: account })
      adapter = one
      const replica = one.conversation

      // The Mac's own record, then what the merge appends to it.
      const { mac, vps } = branches(cwd, '/srv/tade')
      await replica.take(TASK, cwd, canonical(mac), null)
      const record = await replica.recordFor(TASK, cwd)
      const merged = mergeConversations(
        CLAUDE_CONVERSATION,
        { name: 'mac', lines: canonical(mac) },
        { name: 'vps', lines: canonical(vps) },
      )
      if (!merged.ok || !merged.fork) throw new Error('expected a fork')
      const appendix = appendixFor(CLAUDE_CONVERSATION, canonical(mac), merged.lines)
      await replica.take(TASK, cwd, appendix, merged.fork.leaf)
      // Its bookkeeping stayed where it was, the conversation is the merge, and it ends on a pointer.
      const written = readFileSync(record, 'utf8').trim().split('\n')
      expect(canonical(written)).toEqual(canonical([...canonical(mac), ...appendix]))
      expect(JSON.parse(written.at(-1) ?? '{}')).toMatchObject({
        type: 'last-prompt',
        leafUuid: merged.fork.leaf,
      })

      const signals: WorkerSignal[] = []
      const run = 'tade/orchestrator-test/run'
      one.onSignal(run, (signal) => signals.push(signal))
      const env = { ANTHROPIC_BASE_URL: model.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      await one.start({ run, task: TASK, cwd, prompt: '', env })
      await one.prompt(run, 'which words?')
      await until(() => signals.some((s) => s.type === 'idle'), { timeout: 60_000 })
      const sent = JSON.stringify(mainRequest(model)?.messages ?? [])
      // Both sides, in the order the merge put them: the trunk, the marker, the copy.
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

      // Another machine's turn taken in between turns, and read again.
      const before = model.requests.length
      const more = [
        user(id(7), merged.fork.leaf, 'and the word plover', '2026-11-23T13:00:00.000Z', ''),
        reply(id(8), id(7), 'Noted: plover.', '2026-11-23T13:00:01.000Z', ''),
      ]
      // After the turn this process wrote: its own entries, then the other machine's on top.
      const tip = canonical(readFileSync(record, 'utf8').trim().split('\n')).at(-1) ?? ''
      const tipId = JSON.parse(tip).uuid as string
      more[0] = user(id(7), tipId, 'and the word plover', '2026-11-23T13:00:00.000Z', '')
      await replica.take(TASK, cwd, more, id(8))
      await replica.reload(run)
      signals.length = 0
      await one.prompt(run, 'and now?')
      await until(() => signals.some((s) => s.type === 'idle'), { timeout: 60_000 })
      const again = JSON.stringify(mainRequest(model, before)?.messages ?? [])
      expect(again).toContain('plover')
      expect(again).toContain('kestrel')
    }, 150_000)
  })
})

function installed(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/** The last request the main conversation made (one with tools), from `from` on. */
function mainRequest(model: FakeAnthropic, from = 0): { messages?: unknown[] } | undefined {
  return model.requests
    .slice(from)
    .filter((request) => Array.isArray(request.tools) && request.tools.length > 0)
    .at(-1) as { messages?: unknown[] } | undefined
}
