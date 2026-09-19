import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfig, writeSetting } from '../src/config.ts'

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
  })

  it('names a bad enum value by its dotted key', () => {
    const r = parseConfig('workspace:\n  driver: screen\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.path).toBe('workspace.driver')
  })

  it('takes an editor by name, and only one it knows how to open', () => {
    const none = parseConfig('')
    expect(none.ok && none.config.surfaces.window.editor).toBeUndefined()
    const cursor = parseConfig('surfaces:\n  window:\n    editor: cursor\n')
    expect(cursor.ok && cursor.config.surfaces.window.editor).toBe('cursor')
    const notepad = parseConfig('surfaces:\n  window:\n    editor: notepad\n')
    expect(notepad.ok).toBe(false)
    if (notepad.ok) return
    expect(notepad.issues[0]?.path).toBe('surfaces.window.editor')
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
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const r = await loadConfig(join(dir, 'nope.yaml'))
    expect(r.ok && !r.exists).toBe(true)
  })

  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'workers:\n  default: codex\n')
    const r = await loadConfig(path)
    expect(r.ok && r.config.workers.default).toBe('codex')
  })
})

// The config can hold a DSN, and a DSN is a credential: a file anybody on the
// machine can read is the leak nobody notices.
describe('writing a setting', () => {
  it('makes the file the owner’s alone to read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    writeSetting(path, 'telemetry.dsn', 'https://k@o1.ingest.sentry.io/2')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('narrows one that was already readable by everybody', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cfg-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, '# mine\nworkspace: { driver: tmux }\n')
    await chmod(path, 0o644)
    writeSetting(path, 'telemetry.dsn', 'https://k@o1.ingest.sentry.io/2')
    expect((await stat(path)).mode & 0o077).toBe(0)
    // And the file is still the one its owner wrote, comment and all.
    expect(await readFile(path, 'utf8')).toContain('# mine')
  })
})
