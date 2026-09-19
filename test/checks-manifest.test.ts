import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChecks, WORKFLOW_PATH, workflowFor } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'

// Tade's own checks, held to the two things that would make them a lie.
//
// One: the manifest and the gate say the same thing. `pnpm check` stays a
// plain shell line — a Tade that is broken must still be able to tell you it
// is broken, and a gate that imports the thing under test cannot — so the
// two are kept in step by this test rather than by one calling the other.
//
// Two: the workflow is generated, never hand-edited. A change to what this
// project checks is a change to `.tade/checks.yaml` and nothing else.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe("Tade's own checks", () => {
  it('are exactly what `pnpm check` runs, in that order', async () => {
    const manifest = await readChecks({ name: 'tade', root })
    expect(manifest.source).toBe('manifest')
    const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    // Inside a package script `node_modules/.bin` is on PATH and a bare
    // `biome` works; a manifest command is run through a plain shell and has
    // to say `pnpm exec`. That is the one normalisation allowed.
    const gate = (scripts.scripts.check ?? '')
      .split('&&')
      .map((one) => one.trim())
      .map((one) => (one.startsWith('pnpm exec ') ? one : `pnpm exec ${one}`))
    expect(gate).toEqual(manifest.checks.map((check) => check.run))
  })

  it('give the suite the machine to itself', async () => {
    const manifest = await readChecks({ name: 'tade', root })
    expect(manifest.checks.find((check) => check.id === 'tests')?.alone).toBe(true)
  })

  it('are what CI runs: the workflow on disk is the generated one', async () => {
    const manifest = await readChecks({ name: 'tade', root })
    const onDisk = await readFile(join(root, WORKFLOW_PATH), 'utf8')
    // A hand-edited workflow fails here, saying what to run.
    expect(onDisk).toBe(workflowFor(manifest))
  })
})
