import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The real binary, in a real repository. Spawned asynchronously: a blocked
// event loop is a test that hangs instead of failing.
function tade(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? Number((err as { code?: unknown }).code)
            : err
              ? 1
              : 0
        done({ code, stdout, stderr })
      },
    )
  })
}

const MANIFEST = [
  'checks:',
  '  - id: hello',
  '    title: Hello',
  '    run: echo hello',
  'ci:',
  '  runs_on: [ubuntu-latest]',
  '  setup:',
  '    - uses: actions/checkout@v4',
].join('\n')

async function project(manifest = MANIFEST) {
  const repo = mkrepo()
  await mkdir(join(repo.root, '.tade'), { recursive: true })
  await writeFile(join(repo.root, '.tade', 'checks.yaml'), manifest)
  const home = tmp('tade-cli-checks-')
  const config = join(home, 'config.yaml')
  await writeFile(config, `projects:\n  demo:\n    root: ${repo.root}\n`)
  return { repo, home, config, env: { TADE_HOME: home, HOME: home } }
}

describe('tade checks adopt', () => {
  const WORKFLOW = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: tests',
    '        run: echo testing',
  ].join('\n')

  async function withCi() {
    const repo = mkrepo()
    await mkdir(join(repo.root, '.github', 'workflows'), { recursive: true })
    await writeFile(join(repo.root, '.github', 'workflows', 'ci.yml'), WORKFLOW)
    const home = tmp('tade-cli-adopt-')
    const config = join(home, 'config.yaml')
    await writeFile(config, `projects:\n  demo:\n    root: ${repo.root}\n`)
    return { repo, config, env: { TADE_HOME: home, HOME: home } }
  }

  it('shows what it would write, and writes nothing', async () => {
    const where = await withCi()
    const r = await tade(['checks', 'adopt', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('echo testing')
    // What CI does and Tade cannot is said before anything is written.
    expect(r.stderr).toContain('actions/checkout@v4')
    await expect(readFile(join(where.repo.root, '.tade', 'checks.yaml'), 'utf8')).rejects.toThrow()
  })

  it('writes a manifest that the next read uses', async () => {
    const where = await withCi()
    const wrote = await tade(
      ['checks', 'adopt', '--write', '--config', where.config, '-p', 'demo'],
      where.env,
    )
    expect(wrote.code).toBe(0)
    expect(wrote.stdout).toContain('wrote .tade/checks.yaml')
    const listed = await tade(['checks', '--config', where.config, '-p', 'demo'], where.env)
    expect(listed.stdout).toContain('.tade/checks.yaml')
    expect(listed.stdout).toContain('tests')
  })

  it('refuses to adopt over a manifest somebody already wrote', async () => {
    const where = await project()
    const r = await tade(['checks', 'adopt', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('already has')
  })

  it('says so when there is nothing in CI to adopt', async () => {
    const repo = mkrepo()
    const home = tmp('tade-cli-adopt-none-')
    const config = join(home, 'config.yaml')
    await writeFile(config, `projects:\n  demo:\n    root: ${repo.root}\n`)
    const r = await tade(['checks', 'adopt', '--config', config, '-p', 'demo'], {
      TADE_HOME: home,
      HOME: home,
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('no commands in CI')
  })
})

describe('tade checks', () => {
  it('says what a project checks and that nothing has run yet', async () => {
    const where = await project()
    const r = await tade(['checks', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('hello')
    expect(r.stdout).toContain('has not run at this commit')
  })

  it('runs them, records them, and says so the next time it is asked', async () => {
    const where = await project()
    const ran = await tade(['checks', 'run', '--config', where.config, '-p', 'demo'], where.env)
    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('hello passed')
    const again = await tade(['checks', '--config', where.config, '-p', 'demo'], where.env)
    expect(again.stdout).toContain('passed')
    const written = await readFile(join(where.repo.root, '.tade', 'checks.jsonl'), 'utf8')
    expect(written).toContain('"check":"hello"')
  })

  it('exits non-zero on a red check, and says which', async () => {
    const where = await project(
      'checks:\n  - id: nope\n    title: Nope\n    run: echo "8 failed" >&2; exit 1\n',
    )
    const r = await tade(['checks', 'run', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('nope failed')
  })

  it('generates the workflow the manifest implies, and says when the file differs', async () => {
    const where = await project()
    const printed = await tade(
      ['checks', 'workflow', '--config', where.config, '-p', 'demo'],
      where.env,
    )
    expect(printed.stdout).toContain('- name: hello')
    expect(printed.stdout).toContain('run: echo hello')

    const failing = await tade(
      ['checks', 'workflow', '--check', '--config', where.config, '-p', 'demo'],
      where.env,
    )
    expect(failing.code).toBe(1)
    expect(failing.stderr).toContain('regenerate it')

    await mkdir(join(where.repo.root, '.github', 'workflows'), { recursive: true })
    const wrote = await tade(
      ['checks', 'workflow', '--write', '--config', where.config, '-p', 'demo'],
      where.env,
    )
    expect(wrote.code).toBe(0)
    const passing = await tade(
      ['checks', 'workflow', '--check', '--config', where.config, '-p', 'demo'],
      where.env,
    )
    expect(passing.code).toBe(0)
  })
})
