import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getPriority } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'

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

const WORKFLOW = ciWorkflow([{ id: 'hello', run: 'echo hello' }])

async function project(workflow = WORKFLOW) {
  const repo = mkrepo()
  await mkdir(join(repo.root, '.github', 'workflows'), { recursive: true })
  await writeFile(join(repo.root, CI_WORKFLOW), workflow)
  const home = repo.home
  const config = join(home, 'config.yaml')
  await writeFile(config, `projects:\n  demo:\n    root: ${repo.root}\n`)
  return { repo, home, config, env: { TADE_HOME: home, HOME: home } }
}

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
    // Written in Tade's home, under the project — never in the repository.
    const written = await readFile(join(where.home, 'projects', 'demo', 'checks.jsonl'), 'utf8')
    expect(written).toContain('"check":"hello"')
  })

  it('runs them below the window where the config says to, and at full speed where it does not', async () => {
    // The setting reaching the commands, end to end: `runProjectChecks` is the
    // one door a check run goes through — from here, from the window and from
    // an agent's `checks_run` — so proving it here proves it for all three.
    // Asked of the check itself rather than of the code that started it.
    const says = `${process.execPath} -e "require('node:fs').writeFileSync(process.env.OUT, String(require('node:os').getPriority()))"`
    const of = async (giveWay: number | null): Promise<number> => {
      const where = await project(ciWorkflow([{ id: 'nice', run: `true && ${says}` }]))
      const out = join(where.home, 'said')
      if (giveWay !== null) {
        await writeFile(
          where.config,
          `agents:\n  give_way: ${giveWay}\nprojects:\n  demo:\n    root: ${where.repo.root}\n`,
        )
      }
      const ran = await tade(['checks', 'run', '--config', where.config, '-p', 'demo'], {
        ...where.env,
        OUT: out,
      })
      expect(ran.stdout).toContain('nice passed')
      return Number.parseInt(await readFile(out, 'utf8'), 10)
    }
    // Against this process rather than against nought: a suite may itself be
    // running niced, and what is under test is the step down. Clamped at 19,
    // where the kernel clamps it.
    expect(await of(3)).toBe(Math.min(19, getPriority() + 3))
    expect(await of(null)).toBe(getPriority())
  })

  it('exits non-zero on a red check, and says which', async () => {
    const where = await project(ciWorkflow([{ id: 'nope', run: 'echo "8 failed" >&2; exit 1' }]))
    const r = await tade(['checks', 'run', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('nope failed')
  })

  it('says which file it read them from, and what it did not read', async () => {
    const where = await project()
    const r = await tade(['checks', '--config', where.config, '-p', 'demo'], where.env)
    expect(r.stdout).toContain(`read from ${CI_WORKFLOW}`)
    // What CI does and Tade cannot, every time: the install step, and the
    // action nothing here can run.
    expect(r.stderr).toContain('not read here:')
    expect(r.stderr).toContain('actions/checkout@v5')
  })

  it('says a project says nothing, and what would be read if it did', async () => {
    const repo = mkrepo()
    const home = tmp('tade-cli-bare-')
    const config = join(home, 'config.yaml')
    await writeFile(config, `projects:\n  demo:\n    root: ${repo.root}\n`)
    const r = await tade(['checks', '--config', config, '-p', 'demo'], {
      TADE_HOME: home,
      HOME: home,
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('says nothing about what checking it means')
    expect(r.stdout).toContain('test_command')
  })

  it('has no command that writes a project’s checks down', async () => {
    // There is nothing to write: they are read from the project's own CI and
    // its own hook, and a command that wrote them would be the duplication
    // this removed.
    const where = await project()
    for (const gone of ['adopt', 'workflow']) {
      const r = await tade(['checks', gone, '--config', where.config, '-p', 'demo'], where.env)
      expect(r.code, gone).not.toBe(0)
    }
  })
})
