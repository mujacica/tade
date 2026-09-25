import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChecks } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'

// Tade's own checks, and the two things that would make them a lie.
//
// One: what CI runs and what `pnpm check` runs are the same commands. They used
// to be kept in step by generating `ci.yml` from `.tade/checks.yaml`; now the
// workflow is the only list and Tade reads it, so the thing left to hold is the
// shell line — `pnpm check` stays a plain one, because a Tade that is broken
// must still be able to tell you it is broken and a gate that imports the thing
// under test cannot.
//
// Two: the ids are `format`, `types` and `tests`. They are the step names in
// the workflow, they are what `checks_run format` takes, and every run in this
// repository's record is filed under them. A step renamed here is a check
// renamed everywhere, so this test is what makes that a decision rather than an
// accident.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe("Tade's own checks", () => {
  it('are read out of the workflow and the hook, with nothing of Tade’s own', async () => {
    const read = await readChecks({ name: 'tade', root })
    expect(read.source).toBe('CI and hook')
    expect(read.from).toBe('.githooks/pre-commit and .github/workflows/ci.yml')
    // The file that used to define them. Its absence is the change: a project
    // whose CI is readable keeps nothing of Tade's in its repository.
    await expect(readFile(join(root, '.tade/checks.yaml'), 'utf8')).rejects.toThrow()
  })

  it('are called what every run of them is recorded under', async () => {
    const read = await readChecks({ name: 'tade', root })
    expect(read.checks.map((check) => check.id)).toEqual(['pre-commit', 'format', 'types', 'tests'])
  })

  it('are exactly what `pnpm check` runs, in that order', async () => {
    const read = await readChecks({ name: 'tade', root })
    const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    // Inside a package script `node_modules/.bin` is on PATH and a bare
    // `biome` works; a check read from a workflow is run through a plain shell
    // and has to say `pnpm exec`. That is the one normalisation allowed.
    const gate = (scripts.scripts.check ?? '')
      .split('&&')
      .map((one) => one.trim())
      .map((one) => (one.startsWith('pnpm exec ') ? one : `pnpm exec ${one}`))
    const fromCi = read.checks.filter((check) => check.from?.startsWith('.github'))
    expect(fromCi.map((check) => check.run)).toEqual(gate)
  })

  it('give the suite the machine to itself', async () => {
    const read = await readChecks({ name: 'tade', root })
    // Every step of a CI job has the runner to itself, so every check read from
    // one does here too. The suite is why that matters: it spawns real git and
    // PTY processes with short timeouts, and anything beside it starves them.
    expect(read.checks.find((check) => check.id === 'tests')?.alone).toBe(true)
  })

  it('leave the release workflow alone, and say that they did', async () => {
    const read = await readChecks({ name: 'tade', root })
    // The whole of why reading CI is safe enough to be the definition: a
    // release is told from a gate by its trigger, which the file states, and
    // what was not read is named rather than dropped.
    expect(read.problems).toContain(
      '.github/workflows/release.yml was not read: it runs on a tag, which is a release and not a gate',
    )
    expect(read.checks.map((check) => check.from ?? '').join(' ')).not.toContain('release.yml')
  })

  it('do not read what only the runner can do', async () => {
    const read = await readChecks({ name: 'tade', root })
    const said = read.problems.join('\n')
    expect(said).toContain('actions/checkout@v5')
    expect(said).toContain('prepares the machine rather than checking the code')
    expect(read.checks.map((check) => check.id)).not.toContain('tmux')
  })
})
