import { cpSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { claudeCode, codex, parseTranscript, scanTranscripts } from '../src/adoption.ts'

const fx = (p: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/transcripts/${p}`, import.meta.url))

const CODEX_IDLE =
  'codex/0.104/rollout-2026-09-11T09-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl'
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
