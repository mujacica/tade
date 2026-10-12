import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  claudeCode,
  codex,
  newTranscriptReads,
  parseTranscript,
  scanTranscripts,
  type TranscriptParser,
  type TranscriptReads,
  transcriptLoad,
} from '../src/adoption.ts'

const fx = (p: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/transcripts/${p}`, import.meta.url))

const CODEX_IDLE =
  'codex/0.104/rollout-2026-09-11T09-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl'
const CODEX_NEWER =
  'codex/0.154/rollout-2026-09-21T09-47-18-01a0c2ef-021a-7c61-9d70-c2025f5a59ec.jsonl'
const CODEX_APPROVAL =
  'codex/0.104/rollout-2026-09-11T10-00-00-aaaaaaaa-0000-7000-8000-000000000002.jsonl'

describe('claude-code parser', () => {
  it('reads an idle session (turn ended)', async () => {
    const s = await parseTranscript(claudeCode, fx('claude-code/2.1/idle.jsonl'))
    expect(s).toMatchObject({
      provider: 'claude-code',
      parserVersion: 1,
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/work/checkout',
      turn: 'idle',
      title: 'Fix webhook signature check',
      consecutiveFailures: 0,
      lastActivityAt: Date.parse('2026-09-11T09:01:00.000Z'),
    })
  })

  it('treats a trailing tool_use as running and ignores sidechain entries', async () => {
    const s = await parseTranscript(claudeCode, fx('claude-code/2.1/mid-tool.jsonl'))
    expect(s?.turn).toBe('running')
    expect(s?.cwd).toBe('/work/wt/checkout-stripe')
    // It never invents a permission request it can't see.
    expect(s?.pendingPermissions).toEqual([])
  })

  it('counts API errors since the last assistant reply', async () => {
    const s = await parseTranscript(claudeCode, fx('claude-code/2.1/api-errors.jsonl'))
    expect(s?.consecutiveFailures).toBe(3)
    expect(s?.turn).toBe('running')
  })

  it('returns null for an unrecognised shape', async () => {
    expect(await parseTranscript(claudeCode, fx('claude-code/unrecognised.jsonl'))).toBeNull()
  })

  it('returns null for a missing file instead of throwing', async () => {
    expect(await parseTranscript(claudeCode, '/nonexistent/x.jsonl')).toBeNull()
  })

  it('survives a file larger than the tail window (partial first line)', async () => {
    const dir = tmp('tade-adopt-')
    const file = join(dir, 'big.jsonl')
    const filler = `{"type":"progress","data":"${'x'.repeat(1000)}"}\n`.repeat(400)
    const last =
      '{"isSidechain":false,"type":"assistant","message":{"stop_reason":"end_turn"},"timestamp":"2026-09-11T12:00:00Z","cwd":"/big","sessionId":"s-big"}\n'
    writeFileSync(file, filler + last)
    const s = await parseTranscript(claudeCode, file)
    expect(s).toMatchObject({ cwd: '/big', turn: 'idle', sessionId: 's-big' })
  })
})

describe('codex parser', () => {
  it('reads an idle session', async () => {
    const s = await parseTranscript(codex, fx(CODEX_IDLE))
    expect(s).toMatchObject({
      provider: 'codex',
      sessionId: 'aaaaaaaa-0000-7000-8000-000000000001',
      cwd: '/work/search',
      turn: 'idle',
      pendingPermissions: [],
    })
  })

  it('surfaces a pending exec approval as a permission request', async () => {
    const s = await parseTranscript(codex, fx(CODEX_APPROVAL))
    expect(s?.turn).toBe('running')
    expect(s?.pendingPermissions).toEqual(['bash: rm -r test/old'])
  })

  it('reads a session written by a newer Codex, whose lines moved', async () => {
    // 0.154 files `session_id` beside `id`, says the model in `turn_context`
    // and counts tokens in lines 0.104 never wrote. What the adoption parser
    // needs is still there, and a fixture of the older shape alone would not
    // have said so.
    const s = await parseTranscript(codex, fx(CODEX_NEWER))
    expect(s).toMatchObject({
      provider: 'codex',
      sessionId: '01a0c2ef-021a-7c61-9d70-c2025f5a59ec',
      cwd: '/work/search',
      turn: 'idle',
      pendingPermissions: [],
    })
  })

  it('rejects files without a session uuid in the name', async () => {
    expect(await parseTranscript(codex, fx('claude-code/2.1/idle.jsonl'))).toBeNull()
  })
})

describe('scanTranscripts', () => {
  it('finds recent sessions under a fake $HOME and skips old ones', async () => {
    const home = tmp('tade-home-')
    const now = Date.parse('2026-09-11T12:00:00Z')
    const claudeDir = join(home, '.claude/projects/-work-checkout')
    const codexDir = join(home, '.codex/sessions/2026/09/11')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })

    const recent = join(claudeDir, '11111111-1111-4111-8111-111111111111.jsonl')
    const old = join(claudeDir, '22222222-2222-4222-8222-222222222222.jsonl')
    const junk = join(claudeDir, '44444444-4444-4444-8444-444444444444.jsonl')
    const cdx = join(codexDir, CODEX_APPROVAL.split('/').at(-1)!)
    cpSync(fx('claude-code/2.1/idle.jsonl'), recent)
    cpSync(fx('claude-code/2.1/mid-tool.jsonl'), old)
    cpSync(fx('claude-code/unrecognised.jsonl'), junk)
    cpSync(fx(CODEX_APPROVAL), cdx)
    const secs = (t: number) => t / 1000
    for (const f of [recent, junk, cdx]) utimesSync(f, secs(now - 60_000), secs(now - 60_000))
    utimesSync(old, secs(now - 3 * 86_400_000), secs(now - 3 * 86_400_000))

    const r = await scanTranscripts({ home, now, windowMs: 86_400_000 })
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-0000-7000-8000-000000000002',
    ])
    expect(r.warnings).toEqual([expect.stringMatching(/claude-code: 1 transcript/)])
  })

  it('is quiet when no provider directories exist', async () => {
    const r = await scanTranscripts({ home: tmp('tade-home-'), now: Date.now(), windowMs: 1e9 })
    expect(r).toEqual({ sessions: [], warnings: [] })
  })
})

// A window's status child scans every two seconds, so what was read of each
// transcript is kept between scans: a file that has not changed is not opened,
// and one that grew is read from where the last scan stopped. Counted in files
// opened and bytes read, never in wall clock.
describe('a scan asked again with what it read before', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111'
  const line = (entry: object) => `${JSON.stringify(entry)}\n`
  const said = (at: string, extra: object = {}) =>
    line({ type: 'user', sessionId: SESSION, cwd: '/work/checkout', timestamp: at, ...extra })
  const replied = (at: string, stop: string) =>
    line({
      type: 'assistant',
      sessionId: SESSION,
      cwd: '/work/checkout',
      timestamp: at,
      message: { stop_reason: stop },
    })
  const failed = (at: string) => line({ type: 'system', subtype: 'api_error', timestamp: at })

  function claudeHome(): { home: string; dir: string; file: string } {
    const home = tmp('tade-home-')
    const dir = join(home, '.claude/projects/-work-checkout')
    mkdirSync(dir, { recursive: true })
    return { home, dir, file: join(dir, `${SESSION}.jsonl`) }
  }

  const scan = (home: string, reads: TranscriptReads, parsers?: TranscriptParser[]) =>
    scanTranscripts({ home, now: Date.now(), windowMs: 86_400_000, reads, parsers })

  async function cost<T>(work: () => Promise<T>) {
    const before = transcriptLoad()
    const value = await work()
    const after = transcriptLoad()
    return { value, opened: after.opened - before.opened, bytes: after.bytes - before.bytes }
  }

  it('opens nothing on a scan where no transcript changed, and answers the same', async () => {
    const { home, file } = claudeHome()
    writeFileSync(file, said('2026-09-11T09:00:00Z') + replied('2026-09-11T09:00:05Z', 'end_turn'))
    const reads = newTranscriptReads()
    const cold = await cost(() => scan(home, reads))
    const warm = await cost(() => scan(home, reads))
    // The floor as well as the ceiling: the cold scan really did read it.
    expect(cold.opened).toBe(1)
    expect(cold.bytes).toBeGreaterThan(0)
    expect(warm).toMatchObject({ opened: 0, bytes: 0 })
    expect(warm.value).toEqual(cold.value)
    expect(warm.value.sessions[0]?.turn).toBe('idle')
  })

  it('reads only what was appended to a transcript that grew', async () => {
    const { home, file } = claudeHome()
    let text = ''
    for (let i = 0; i < 200; i++) text += said(`2026-09-11T09:00:00Z`, { pad: 'x'.repeat(500) })
    writeFileSync(file, text)
    const reads = newTranscriptReads()
    await scan(home, reads)
    const more = replied('2026-09-11T09:05:00Z', 'end_turn')
    appendFileSync(file, more)
    const warm = await cost(() => scan(home, reads))
    expect(warm.opened).toBe(1)
    // What was appended, and a few bytes before it to be sure it was appended
    // to rather than rewritten: never the hundred kilobytes before that.
    expect(warm.bytes).toBeGreaterThanOrEqual(more.length)
    expect(warm.bytes).toBeLessThan(more.length + 1024)
    expect(warm.value.sessions[0]).toMatchObject({
      turn: 'idle',
      lastActivityAt: Date.parse('2026-09-11T09:05:00Z'),
    })
  })

  it('reads a line written in two halves once, whole', async () => {
    const { home, file } = claudeHome()
    writeFileSync(file, said('2026-09-11T09:00:00Z'))
    const reads = newTranscriptReads()
    await scan(home, reads)

    // A last line with no newline yet is read for this answer, and not kept.
    appendFileSync(file, failed('2026-09-11T09:00:01Z').trimEnd())
    expect((await scan(home, reads)).sessions[0]?.consecutiveFailures).toBe(1)
    appendFileSync(file, '\n')
    expect((await scan(home, reads)).sessions[0]?.consecutiveFailures).toBe(1)

    // Half a line is no line at all, until the rest of it arrives.
    const next = failed('2026-09-11T09:00:02Z')
    appendFileSync(file, next.slice(0, 20))
    expect((await scan(home, reads)).sessions[0]?.consecutiveFailures).toBe(1)
    appendFileSync(file, next.slice(20))
    expect((await scan(home, reads)).sessions[0]?.consecutiveFailures).toBe(2)
  })

  it('reads a transcript rewritten rather than appended to from the start', async () => {
    const { home, file } = claudeHome()
    writeFileSync(file, failed('2026-09-11T09:00:00Z') + said('2026-09-11T09:00:01Z'))
    const reads = newTranscriptReads()
    expect((await scan(home, reads)).sessions[0]?.turn).toBe('running')

    // Longer than before, and what was before is not there any more.
    writeFileSync(
      file,
      said('2026-09-11T10:00:00Z', { cwd: '/work/elsewhere' }) +
        replied('2026-09-11T10:00:01Z', 'end_turn'),
    )
    const after = (await scan(home, reads)).sessions[0]
    expect(after).toMatchObject({ turn: 'idle', cwd: '/work/checkout', consecutiveFailures: 0 })

    // And shorter than before.
    writeFileSync(file, said('2026-09-11T11:00:00Z', { cwd: '/w' }))
    expect((await scan(home, reads)).sessions[0]).toMatchObject({ turn: 'running', cwd: '/w' })
  })

  it('answers what reading from the start answers, however the writes fall', async () => {
    const home = tmp('tade-home-')
    const claudeDir = join(home, '.claude/projects/-work-checkout')
    const codexDir = join(home, '.codex/sessions/2026/09/11')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })
    const cases = [
      ['claude-code/2.1/api-errors.jsonl', join(claudeDir, `${SESSION}.jsonl`)],
      [CODEX_APPROVAL, join(codexDir, CODEX_APPROVAL.split('/').at(-1)!)],
      [CODEX_NEWER, join(codexDir, CODEX_NEWER.split('/').at(-1)!)],
    ] as const
    for (const [fixture, file] of cases) {
      const whole = readFileSync(fx(fixture))
      const parser = fixture.startsWith('codex') ? codex : claudeCode
      const reads = newTranscriptReads()
      writeFileSync(file, '')
      // Cuts that fall mid-line, on a newline, and past several lines at once.
      const steps = [1, 7, 40, 333, 2]
      for (let at = 0, i = 0; at < whole.length; i++) {
        const to = Math.min(whole.length, at + steps[i % steps.length]!)
        appendFileSync(file, whole.subarray(at, to))
        at = to
        const kept = (await scan(home, reads, [parser])).sessions.find((s) => s.file === file)
        expect(kept ?? null).toEqual(await parseTranscript(parser, file))
      }
      expect(await parseTranscript(parser, file)).toEqual(
        await parseTranscript(parser, fx(fixture)).then((s) => s && { ...s, file }),
      )
    }
  })

  it('forgets a transcript that has gone', async () => {
    const { home, file } = claudeHome()
    writeFileSync(file, said('2026-09-11T09:00:00Z'))
    const reads = newTranscriptReads()
    expect((await scan(home, reads)).sessions).toHaveLength(1)
    rmSync(file)
    expect(await scan(home, reads)).toEqual({ sessions: [], warnings: [] })
  })

  it.skipIf(process.getuid?.() === 0)(
    'keeps what it last read of a folder it cannot look in, and says it could not look',
    async () => {
      const { home, dir, file } = claudeHome()
      writeFileSync(file, said('2026-09-11T09:00:00Z'))
      const reads = newTranscriptReads()
      const before = await scan(home, reads)
      chmodSync(dir, 0o000)
      try {
        const after = await scan(home, reads)
        // Not a session that has gone, which is what an empty list would say.
        expect(after.sessions).toEqual(before.sessions)
        expect(after.warnings).toEqual([
          expect.stringMatching(/^claude-code: some transcripts could not be read \(EACCES\)$/),
        ])
        // And a scan with nothing to fall back on says the same, with nothing.
        const fresh = await scanTranscripts({ home, now: Date.now(), windowMs: 86_400_000 })
        expect(fresh).toEqual({ sessions: [], warnings: after.warnings })
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )

  it.skipIf(process.getuid?.() === 0)(
    'keeps what it last read of a transcript it cannot open, and says it could not look',
    async () => {
      const { home, file } = claudeHome()
      writeFileSync(file, said('2026-09-11T09:00:00Z'))
      const reads = newTranscriptReads()
      const before = await scan(home, reads)
      // Grown, so there is something to read, and then shut.
      appendFileSync(file, replied('2026-09-11T09:00:01Z', 'end_turn'))
      chmodSync(file, 0o000)
      try {
        const after = await scan(home, reads)
        expect(after.sessions).toEqual(before.sessions)
        expect(after.warnings).toEqual(['claude-code: some transcripts could not be read (EACCES)'])
      } finally {
        chmodSync(file, 0o644)
      }
      // And once it can be read again, it is read: what stood was never kept as the answer.
      expect((await scan(home, reads)).sessions[0]?.turn).toBe('idle')
    },
  )

  it.skipIf(process.getuid?.() === 0)(
    'keeps what it last read of a transcript in a folder it can list but not look into',
    async () => {
      const { home, dir, file } = claudeHome()
      writeFileSync(file, said('2026-09-11T09:00:00Z'))
      const reads = newTranscriptReads()
      const before = await scan(home, reads)
      // Its names can be read, and nothing about any file in it can.
      chmodSync(dir, 0o444)
      try {
        const after = await scan(home, reads)
        expect(after.sessions).toEqual(before.sessions)
        expect(after.warnings).toEqual(['claude-code: some transcripts could not be read (EACCES)'])
      } finally {
        chmodSync(dir, 0o755)
      }
    },
  )

  it('reads a transcript whose parser threw as unrecognised, and from the start once it changes', async () => {
    const { home, file } = claudeHome()
    const fussy: TranscriptParser = {
      ...(claudeCode as TranscriptParser),
      read(known, lines) {
        const all = [...lines]
        if (all.some((e) => e.boom === true)) throw new Error('a bug in a parser')
        return claudeCode.read(known as Parameters<typeof claudeCode.read>[0], all)
      },
    }
    writeFileSync(file, said('2026-09-11T09:00:00Z', { boom: true }))
    const reads = newTranscriptReads()
    expect(await scan(home, reads, [fussy])).toEqual({
      sessions: [],
      warnings: ['claude-code: 1 transcript(s) in an unrecognised format (parser v1)'],
    })
    writeFileSync(file, said('2026-09-11T09:00:00Z') + replied('2026-09-11T09:00:01Z', 'end_turn'))
    expect((await scan(home, reads, [fussy])).sessions[0]?.turn).toBe('idle')
  })
})
