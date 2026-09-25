import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  it('config --check says a setting Tade no longer has, and still passes the file', async () => {
    // The point of ignoring rather than refusing is that the person is told:
    // a key that quietly does nothing is a key somebody goes on believing in.
    const dir = await mkdtemp(join(tmpdir(), 'tade-cli-'))
    const path = join(dir, 'config.yaml')
    await writeFile(
      path,
      'workers:\n  routes:\n    default: { model: claude-opus-5, sandbox: seatbelt }\n',
    )
    const r = tade(['config', '--check', '--config', path])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(': ok')
    expect(r.stderr).toContain('workers.routes.default.sandbox is ignored')
    expect(r.stderr).toContain('sandboxes are gone from Tade')
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

  // One folder, and being in it is not being on. This is the whole of the
  // safety around what Tade writes for itself, so it is exercised through the
  // real binary: the move out of the old places, what is listed, and that
  // turning one on is a setting rather than a file being moved somewhere.
  it('lists extensions off until they are turned on, and enable writes it down', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-ext-'))
    const root = join(home, 'extensions')
    await mkdir(join(root, 'proposed'), { recursive: true })
    await writeFile(
      join(root, 'proposed', 'standup.ts'),
      '// Reads out what each agent did yesterday.\nexport default function () {}\n',
    )
    const path = join(home, 'config.yaml')
    await writeFile(path, `orchestrator:\n  extensions: ${root}\n`)

    const listed = tade(['extensions', 'list', '--config', path], { TADE_HOME: home })
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('standup: off — Reads out what each agent did yesterday.')
    expect(listed.stdout).toContain('tade extensions enable <name>')
    // Moved out of `proposed/` into the one folder, and nothing was run.
    await expect(access(join(root, 'standup.ts'))).resolves.toBeUndefined()

    // `activate` is the old name for it, and still works.
    const on = tade(['extensions', 'activate', 'standup', '--config', path], { TADE_HOME: home })
    expect(on.code).toBe(0)
    expect(on.stdout).toContain('the next time Tade starts')
    expect(await readFile(path, 'utf8')).toContain('enabled: true')
    expect(tade(['extensions', 'list', '--config', path], { TADE_HOME: home }).stdout).toContain(
      'standup: on',
    )

    // A name nothing answers to is refused rather than written down.
    const missing = tade(['extensions', 'enable', 'nothing-here', '--config', path], {
      TADE_HOME: home,
    })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('no extension called nothing-here')
  }, 30_000)

  // `pnpm link --global` puts a `tade` shim on PATH that execs whatever `bin.tade`
  // names. If the entry goes missing or stops pointing at a runnable file, the
  // install path in the README silently stops working.
  it('ships a `tade` bin entry pointing at a runnable bin.ts', async () => {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(await readFile(manifest, 'utf8')) as {
      bin?: Record<string, string>
    }
    expect(pkg.bin?.tade).toBe('./src/bin.ts')

    const entry = resolve(manifest, '..', pkg.bin?.tade ?? '')
    expect(entry).toBe(bin)
    await expect(access(entry, constants.X_OK)).resolves.toBeUndefined()
    expect(await readFile(entry, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
  })
})
