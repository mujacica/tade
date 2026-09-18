import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// Runs the real binary under plain node (native type stripping), so this also
// proves the no-build-step setup works end to end.
function tade(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('tade CLI', () => {
  it('prints its version', () => {
    const r = tade(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('config --check on a broken YAML names the bad key and exits 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cli-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'workspace:\n  driver: screen\n')
    const r = tade(['config', '--check', '--config', path])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('workspace.driver')
  })

  it('config --check passes on a valid file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cli-'))
    const path = join(dir, 'config.yaml')
    await writeFile(path, 'workspace:\n  driver: pty\n')
    const r = tade(['config', '--check', '--config', path])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(': ok')
  })

  it('config --check defaults to $TADE_HOME/config.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tade-cli-'))
    const r = tade(['config', '--check'], { TADE_HOME: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('not found, using defaults')
  })

  it('an unknown command exits 2', () => {
    expect(tade(['frobnicate']).code).toBe(2)
  })
})
