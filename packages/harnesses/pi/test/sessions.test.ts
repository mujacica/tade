import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { PiAdapter, sessionIdFor } from '../src/adapter.ts'
import {
  answerOfTask,
  historyLine,
  historyOfTask,
  sessionDirFor,
  sessionFileFor,
  sessionsOf,
  sessionsRoot,
  usageOf,
  usageOfTask,
} from '../src/sessions.ts'

// Reading an agent's spend out of the harness's own session file, which is the
// record that survives Tade being closed.
//
// The files here are written by hand rather than by a real agent: what is under
// test is that we read a private format defensively, and a fabricated file can
// contain the shapes a real one would take years to produce. Every entry is
// shaped the way pi writes it — a reply's usage on its message, a summary's on
// the entry — copied from a real session: a fixture that put usage anywhere
// kinder once let Tade count compactions and not one reply.

/** Write a session where the harness would put one for this cwd. */
function writeSession(root: string, cwd: string, task: string, lines: unknown[]): string {
  const dir = sessionDirFor(cwd, root)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor(task)}.jsonl`)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

const usage = (input: number, output: number, usd: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
})

/** A reply, as pi writes one. */
const priced = (input: number, output: number, usd: number, cacheRead = 0) => ({
  type: 'message',
  id: 'a1b2c3d4',
  parentId: 'e5f6a7b8',
  timestamp: '2026-09-14T07:25:44.133Z',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.6',
    usage: usage(input, output, usd, cacheRead),
    stopReason: 'stop',
    timestamp: 1789370742438,
  },
})

describe('reading a task’s session', () => {
  it('finds the session pi carries on in that working directory, and no other', async () => {
    const root = tmp('pi-sessions-')
    const written = writeSession(root, '/src/app-refunds', 'app/refunds', [priced(10, 5, 0.01)])
    expect(await sessionFileFor('app/refunds', '/src/app-refunds', { root })).toBe(written)
    // pi looks for a session id in its own directory alone, so one the task
    // left under another is not the conversation it would continue.
    writeSession(root, '/src/elsewhere', 'app/moved', [priced(10, 5, 0.01)])
    expect(await sessionFileFor('app/moved', '/src/app-refunds', { root })).toBeNull()
  })

  it('finds a session through a symlink, where pi filed it under the real path', async () => {
    const root = tmp('pi-sessions-')
    const real = tmp('pi-cwd-')
    const linked = join(tmp('pi-link-'), 'here')
    symlinkSync(real, linked)
    const written = writeSession(root, real, 'app/linked', [priced(10, 5, 0.01)])
    expect(await sessionFileFor('app/linked', linked, { root })).toBe(written)
  })

  it('names the directory the way pi does', async () => {
    const agentDir = tmp('pi-agent-')
    const was = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      // pi's own, asked rather than copied: it makes the directory it names.
      const { SessionManager } = await import('@earendil-works/pi-coding-agent')
      for (const cwd of ['/Users/x/src/app', '/srv/a:b/c d/é']) {
        expect(sessionDirFor(cwd, join(agentDir, 'sessions'))).toBe(
          SessionManager.create(cwd).getSessionDir(),
        )
      }
    } finally {
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = was
    }
  })

  it('looks in pi’s agent directory wherever PI_CODING_AGENT_DIR puts it', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const was = process.env.PI_CODING_AGENT_DIR
    const from = process.cwd()
    // A lane's pi runs in its working directory, which a relative one is read against.
    const cwd = tmp('pi-cwd-')
    process.chdir(cwd)
    try {
      for (const moved of [undefined, tmp('pi-agent-'), '~/elsewhere/agent', '~', 'own/agent']) {
        // pi reads its own process's environment; Tade reads the one it hands pi.
        if (moved === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = moved
        const launched = moved === undefined ? {} : { PI_CODING_AGENT_DIR: moved }
        expect(sessionDirFor(cwd, sessionsRoot(launched))).toBe(
          SessionManager.create(cwd).getSessionDir(),
        )
      }
    } finally {
      process.chdir(from)
      if (was === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = was
    }
  })

  it('is found by an adapter whose pi is launched with its agent directory moved', async () => {
    const agentDir = tmp('pi-agent-')
    const cwd = tmp('pi-cwd-')
    writeSession(join(agentDir, 'sessions'), cwd, 'app/moved', [priced(10, 5, 0.01)])
    const moved = new PiAdapter({ runDir: tmp('tade-pi-'), env: { PI_CODING_AGENT_DIR: agentDir } })
    expect(await moved.hasConversation('app/moved', cwd)).toBe(true)
    expect(await moved.spent('app/moved', cwd)).toMatchObject({ tokens: 15, messages: 1 })
    expect((await moved.history('app/moved', cwd, { limit: 50 })).items).toHaveLength(1)
    // Launched without it, pi files them in the home, and so that is where it looks.
    const home = new PiAdapter({ runDir: tmp('tade-pi-'), env: {} })
    expect(await home.hasConversation('app/moved', cwd)).toBe(false)
  })

  it('looks in the one directory a sessionDir in pi’s settings names, the project’s over its own', async () => {
    const { SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const agentDir = tmp('pi-agent-')
    const cwd = tmp('pi-cwd-')
    mkdirSync(join(cwd, '.pi'))
    const own = sessionDirFor(cwd, join(agentDir, 'sessions'))
    const cases: [mine: string | null, project: string | null][] = [
      [null, null],
      [JSON.stringify({ sessionDir: tmp('pi-flat-') }), null],
      [JSON.stringify({ sessionDir: '~/flat' }), null],
      [`\ufeff${JSON.stringify({ sessionDir: '~' })}`, null],
      [JSON.stringify({ sessionDir: tmp('pi-flat-') }), JSON.stringify({ sessionDir: 'own/flat' })],
      // A project may turn its owner's off, and one pi cannot read is no settings at all.
      [JSON.stringify({ sessionDir: tmp('pi-flat-') }), JSON.stringify({ sessionDir: '' })],
      [JSON.stringify({ sessionDir: tmp('pi-flat-') }), '{ not json'],
      [JSON.stringify({ theme: 'dark' }), JSON.stringify({ sessionDir: null })],
    ]
    for (const [mine, project] of cases) {
      for (const [file, text] of [
        [join(agentDir, 'settings.json'), mine],
        [join(cwd, '.pi', 'settings.json'), project],
      ] as const) {
        if (text === null) rmSync(file, { force: true })
        else writeFileSync(file, text)
      }
      // pi's own merge, asked rather than copied; a relative one is read from where pi runs.
      const named = SettingsManager.create(cwd, agentDir).getSessionDir()
      const dir = named ? resolve(cwd, named) : own
      expect(await sessionsOf(cwd, { PI_CODING_AGENT_DIR: agentDir })).toEqual({
        dir,
        shared: dir !== own,
      })
    }
    // PI_CODING_AGENT_SESSION_DIR comes before any setting (pi's `main`), read the same way.
    expect(
      await sessionsOf(cwd, { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: '~/s' }),
    ).toEqual({ dir: join(homedir(), 's'), shared: true })
    expect(
      await sessionsOf(cwd, { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: 'here' }),
    ).toEqual({ dir: join(cwd, 'here'), shared: true })
    // Settings that are there and cannot be read are not settings that say nothing.
    rmSync(join(agentDir, 'settings.json'), { force: true })
    mkdirSync(join(agentDir, 'settings.json'))
    await expect(sessionsOf(cwd, { PI_CODING_AGENT_DIR: agentDir })).rejects.toThrow(
      /could not read pi's settings/,
    )
  })

  it('finds a session where pi keeps every working directory’s together, only in the one it was started in', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    const flat = tmp('pi-flat-')
    const cwd = tmp('pi-cwd-')
    const other = tmp('pi-cwd-')
    const id = sessionIdFor('app/flat')
    // pi writes this one itself, header and all, as it does under a sessionDir.
    const session = SessionManager.create(cwd, flat, { id })
    session.appendMessage({ role: 'user', content: 'go', timestamp: 1 })
    session.appendMessage(
      priced(10, 5, 0.01).message as Parameters<typeof session.appendMessage>[0],
    )
    const written = session.getSessionFile()
    // The same task started somewhere else, later, so it is the newest by name.
    const elsewhere = join(flat, `2099-01-01T00-00-00-000Z_${id}.jsonl`)
    writeFileSync(
      elsewhere,
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2099-01-01T00:00:00.000Z', cwd: other })}\n${JSON.stringify(priced(1, 1, 0.5))}\n`,
    )
    const env = { PI_CODING_AGENT_SESSION_DIR: flat }
    // Held to pi's own lookup: it continues only a session its header says began here.
    for (const [where, found] of [
      [cwd, written],
      [other, elsewhere],
      [tmp('pi-cwd-'), undefined],
    ] as const) {
      expect(SessionManager.findById(where, id, flat)).toBe(found)
      expect(await sessionFileFor('app/flat', where, { env })).toBe(found ?? null)
    }

    const moved = new PiAdapter({ runDir: tmp('tade-pi-'), env })
    expect(await moved.hasConversation('app/flat', cwd)).toBe(true)
    expect(await moved.spent('app/flat', cwd)).toMatchObject({ tokens: 15, messages: 1 })
    expect((await moved.history('app/flat', cwd, { limit: 50 })).items).toHaveLength(2)
    // Named in its settings rather than its environment, it is the same directory.
    const agentDir = tmp('pi-agent-')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: flat }))
    const set = new PiAdapter({ runDir: tmp('tade-pi-'), env: { PI_CODING_AGENT_DIR: agentDir } })
    expect(await set.spent('app/flat', cwd)).toMatchObject({ tokens: 15, messages: 1 })
    // Told neither, pi files them by working directory, and so that is where it looks.
    const home = new PiAdapter({ runDir: tmp('tade-pi-'), env: {} })
    expect(await home.hasConversation('app/flat', cwd)).toBe(false)
  })

  it('has nothing to say about a task that has never run', async () => {
    const root = tmp('pi-sessions-')
    expect(await sessionFileFor('app/ghost', '/src/app-ghost', { root })).toBeNull()
    expect(await usageOfTask('app/ghost', '/src/app-ghost', { root })).toMatchObject({
      messages: 0,
      tokens: 0,
    })
  })

  it('sums every priced message', async () => {
    const root = tmp('pi-sessions-')
    writeSession(root, '/src/app-refunds', 'app/refunds', [
      { type: 'session', version: 3, id: 'tade-app-refunds', cwd: '/src/app-refunds' },
      priced(100, 20, 0.03),
      { type: 'message', message: { role: 'user', content: 'go on', timestamp: 1 } },
      priced(50, 10, 0.02),
    ])
    const usage = await usageOfTask('app/refunds', '/src/app-refunds', { root })
    expect(usage).toMatchObject({ input: 150, output: 30, tokens: 180, messages: 2 })
    expect(usage.usd).toBeCloseTo(0.05)
    expect(usage.model).toBe('openrouter/moonshotai/kimi-k2.6')
  })

  it('counts what pi counts, and so agrees with the footer of the agent', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-costly', 'app/costly', [
      { type: 'model_change', provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6' },
      // Most of what a long session costs is reading its own cache back.
      priced(4_368, 63, 0.0046, 1_520),
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'read', content: [], isError: false },
      },
      // A tool that ran a model of its own says so on its result.
      {
        type: 'message',
        message: { role: 'toolResult', toolName: 'ask', content: [], usage: usage(10, 5, 0.001) },
      },
      // Compacting is a model writing a summary, and is paid for like one.
      {
        type: 'compaction',
        summary: 'what happened so far',
        firstKeptEntryId: 'ca71eb30',
        tokensBefore: 257_982,
        usage: usage(31_879, 11_681, 0.077, 48),
        fromHook: false,
      },
      {
        type: 'branch_summary',
        fromId: 'x',
        summary: 'the other branch',
        usage: usage(7, 3, 0.0005),
      },
      // Usage anywhere pi does not put it is not usage.
      { type: 'message', usage: usage(1_000_000, 0, 100) },
      { type: 'custom', customType: 'notes', data: { usage: usage(1_000_000, 0, 100) } },
    ])
    const spent = await usageOf(path)
    expect(spent).toMatchObject({
      input: 4_368 + 10 + 31_879 + 7,
      output: 63 + 5 + 11_681 + 3,
      cacheRead: 1_520 + 48,
      messages: 4,
    })
    expect(spent.tokens).toBe(spent.input + spent.output + spent.cacheRead)
    expect(spent.usd).toBeCloseTo(0.0046 + 0.001 + 0.077 + 0.0005)
  })

  it('reads a session that is being written to right now', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-live', 'app/live', [priced(10, 5, 0.01)])
    // A live session's last line is whatever made it to disk so far. Skipping
    // it is right; throwing over it would lose the whole file's accounting.
    writeFileSync(path, `${JSON.stringify(priced(10, 5, 0.01))}\n{"type":"mess`)
    expect(await usageOf(path)).toMatchObject({ messages: 1, tokens: 15 })
  })

  it('counts nothing rather than guessing when the shapes are unfamiliar', async () => {
    const root = tmp('pi-sessions-')
    const path = writeSession(root, '/src/app-odd', 'app/odd', [
      { type: 'message', message: { role: 'assistant', usage: { input: 'lots', cost: 'free' } } },
      { type: 'message', message: { role: 'assistant', usage: null } },
      { type: 'compaction', usage: { totalTokens: Number.NaN, cost: { total: 'a lot' } } },
      { type: 'message', message: 'hello' },
    ])
    // The format is the harness's and will change. Unknown is zero, never NaN:
    // one NaN would poison every total that adds it.
    const usage = await usageOf(path)
    expect(usage.tokens).toBe(0)
    expect(usage.usd).toBe(0)
  })
})

describe('a conversation read back', () => {
  // Shaped as pi 0.7x writes a headless session: flat in `--session-dir`.
  const lines = [
    { type: 'session', version: 3, id: 'tade-orchestrator', timestamp: '2026-09-19T11:47:15.509Z' },
    { type: 'model_change', id: 'a1', provider: 'openrouter', modelId: 'anthropic/claude-opus-5' },
    {
      type: 'message',
      id: 'b1',
      timestamp: '2026-09-19T11:47:16.000Z',
      message: { role: 'system', content: '' },
    },
    {
      type: 'message',
      id: 'b2',
      timestamp: '2026-09-19T11:47:17.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'What they said:\nwhy is it purple?' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    },
    {
      type: 'message',
      id: 'b3',
      timestamp: '2026-09-19T11:47:18.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'look first' },
          { type: 'text', text: 'Looking at the palette.' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'rg violet' } },
          { type: 'toolCall', id: 't2', name: 'tade_status', arguments: {} },
        ],
      },
    },
    {
      type: 'message',
      id: 'b4',
      timestamp: '2026-09-19T11:47:19.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'rg: not found' }],
      },
    },
    {
      type: 'message',
      id: 'b5',
      timestamp: '2026-09-19T11:47:19.500Z',
      message: {
        role: 'toolResult',
        toolCallId: 't2',
        toolName: 'tade_status',
        isError: false,
        content: [{ type: 'text', text: '{}' }],
      },
    },
    {
      type: 'message',
      id: 'b6',
      timestamp: '2026-09-19T11:47:20.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'It is `#8700d7` now.' }] },
    },
  ]

  it('is what was sent, what it said and its tools, out of the session a headless run keeps', async () => {
    const headless = tmp('tade-pi-headless-')
    writeFileSync(
      join(headless, `2026-09-19T11-47-15-509Z_${sessionIdFor('tade/orchestrator')}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    const page = await historyOfTask(
      'tade/orchestrator',
      '/work/tade',
      { limit: 50 },
      { root: tmp('tade-pi-root-'), headless },
    )
    expect(page.earlier).toBeNull()
    expect(page.items).toEqual([
      {
        kind: 'sent',
        text: 'What they said:\nwhy is it purple?',
        images: ['picture'],
        at: Date.parse('2026-09-19T11:47:17.000Z'),
      },
      {
        kind: 'reply',
        text: 'Looking at the palette.',
        at: Date.parse('2026-09-19T11:47:18.000Z'),
      },
      expect.objectContaining({
        kind: 'tool',
        tool: 'bash',
        input: { command: 'rg violet' },
        ok: false,
        result: 'rg: not found',
      }),
      expect.objectContaining({ kind: 'tool', tool: 'tade_status', ok: true, result: '{}' }),
      { kind: 'reply', text: 'It is `#8700d7` now.', at: Date.parse('2026-09-19T11:47:20.000Z') },
    ])
    // Opened, a call's answer is read again from the same file by its id.
    const at = { root: tmp('tade-pi-root-'), headless }
    expect(await answerOfTask('tade/orchestrator', '/work/tade', 't1', at)).toEqual({
      ok: false,
      result: 'rg: not found',
    })
    expect(await answerOfTask('tade/orchestrator', '/work/tade', 't9', at)).toBeNull()
  })

  it('finds a session in a lane where pi files it, and nothing for a task with none', async () => {
    const root = tmp('tade-pi-root-')
    writeSession(root, '/work/shop', 'shop/purple', lines)
    const page = await historyOfTask('shop/purple', '/work/shop', { limit: 50 }, { root })
    expect(page.items.map((item) => item.kind)).toEqual(['sent', 'reply', 'tool', 'tool', 'reply'])
    expect(await historyOfTask('shop/other', '/work/shop', { limit: 50 }, { root })).toEqual({
      items: [],
      earlier: null,
    })
    expect(historyLine('{"type":"model_change"}')).toBeNull()
    expect(historyLine('{"type":"message","message":{"role":"system","content":""}}')).toBeNull()
  })
})

describe("a tool call's answer read back", () => {
  it('is kept whole when it worked, however long', () => {
    const answer = (text: string) =>
      historyLine(
        JSON.stringify({
          type: 'message',
          timestamp: '2026-10-18T10:00:00.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 't1',
            isError: false,
            content: [{ type: 'text', text }],
          },
        }),
      )?.results
    expect(answer('two files')).toEqual([{ id: 't1', ok: true, result: 'two files' }])
    const long = Array.from({ length: 5_000 }, (_, n) => `${n}`).join('\n')
    expect(answer(long)).toEqual([{ id: 't1', ok: true, result: long }])
  })
})
