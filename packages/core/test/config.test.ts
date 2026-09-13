import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfig } from '../src/config.ts'

describe('parseConfig', () => {
  it('fills defaults for an empty file', () => {
    const r = parseConfig('')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.workspace.driver).toBe('pty')
    expect(r.config.workers.default).toBe('default')
    expect(r.config.workers.routes.default?.harness).toBe('pi')
    expect(r.config.projects).toEqual({})
  })

  it('accepts a fully populated config', () => {
    const r = parseConfig(`
workspace: { driver: tmux, adopt: true }
orchestrator: { harness: pi, provider: anthropic, model: claude-opus-5 }
workers:
  default: cheap
  routes:
    cheap: { provider: openrouter, model: deepseek/deepseek-v3 }
    subscription: { provider: anthropic, model: claude-opus-5, sandbox: seatbelt }
surfaces:
  voice:
    stt: { driver: groq, language: en, api_key_env: GROQ_API_KEY }
    mic: { driver: ffmpeg, device: ":1" }
projects:
  checkout: { root: ~/src/checkout, brief: "Payments.", worker: subscription, max_parallel: 2 }
`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.projects.checkout?.max_parallel).toBe(2)
    expect(r.config.workers.routes.subscription?.sandbox).toBe('seatbelt')
    expect(r.config.orchestrator.mode).toBe('headless')
  })

  it('names a bad enum value by its dotted key', () => {
    const r = parseConfig('workspace:\n  driver: screen\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('workspace.driver')
  })

  it('names an unknown (typo) key', () => {
    const r = parseConfig('workspace:\n  drivr: pty\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('workspace.drivr')
  })

  it('names a key inside a project record', () => {
    const r = parseConfig('projects:\n  checkout:\n    root: ~/x\n    max_parallel: -1\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('projects.checkout.max_parallel')
  })

  it('reports unparseable YAML as a file-level issue', () => {
    const r = parseConfig('workspace: [unclosed\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('')
    expect(r.issues[0]?.message).toMatch(/invalid YAML/)
  })
})

describe('loadConfig', () => {
  it('treats a missing file as defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wilco-cfg-'))
    const r = await loadConfig(join(dir, 'nope.yaml'))
    expect(r.ok && !r.exists).toBe(true)
  })

  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wilco-cfg-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'workers:\n  default: codex\n')
    const r = await loadConfig(path)
    expect(r.ok && r.config.workers.default).toBe('codex')
  })
})
