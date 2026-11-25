import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from './fixtures/mkrepo.ts'

// A machine's host name never reaches anything Tade publishes.
//
// It did: the Mac dials the server, so the server knew the Mac by nothing but
// its host name — a serial number and the router's domain — and named it that
// way in a merge it proposed for two machines' parted `main`. The merge went to
// a public forge as a branch, a title, a body and ten commit messages, and a
// forge keeps a closed pull request's head ref for good. Now a machine is
// called by the name the person gave it (`machine.name`, or the kind of machine
// it is), and that name is what crosses the link.
//
// The host here is a placeholder the shape of the real one; the real one is
// never written in this repository.

const HOST = vi.hoisted(() => 'SERIAL7Q2X.laptop.example')

vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  const hostname = () => HOST
  return { ...os, hostname, default: { ...os, hostname } }
})

const {
  formerLabel,
  hostNameIn,
  INTAKE_SAYINGS,
  intakeSays,
  loadConfig,
  machineLabel,
  machineNameByDefault,
  mergeMessage,
  mergeProposal,
  mergeSlugStem,
  mirrorMachine,
  nameThisMachine,
} = await import('../packages/core/src/index.ts')
const { intakeMachine } = await import('../packages/workbench/src/intake.ts')

const { scrub } = await import('../packages/telemetry/src/shape.ts')

const ROOT = fileURLToPath(new URL('..', import.meta.url))

afterEach(() => nameThisMachine(undefined))

describe("a machine's host name", () => {
  it('is what the placeholder host is, so every check below is about it', () => {
    expect(hostNameIn(formerLabel())).toBe(true)
    expect(hostNameIn(mirrorMachine(formerLabel()))).toBe(true)
    expect(hostNameIn('serial7q2x')).toBe(true)
    expect(hostNameIn("Merge ipax's main into main")).toBe(false)
  })

  it('is not what this machine is called, named or not', async () => {
    expect(machineLabel()).toBe(machineNameByDefault())
    expect(hostNameIn(machineLabel())).toBe(false)
    const path = join(tmp('tade-name-'), 'config.yaml')
    writeFileSync(path, 'machine:\n  name: studio\n')
    const loaded = await loadConfig(path)
    expect(loaded.ok).toBe(true)
    expect(machineLabel()).toBe('studio')
  })

  it('refuses a name a ref namespace or another meaning would trip over', async () => {
    for (const name of ['origin', 'here', 'Has Spaces', 'x'.repeat(25)]) {
      const path = join(tmp('tade-name-'), 'config.yaml')
      writeFileSync(path, `machine:\n  name: ${JSON.stringify(name)}\n`)
      const loaded = await loadConfig(path)
      expect(loaded.ok, name).toBe(false)
    }
  })

  it('is in no branch, title, prompt or commit message of a merge proposed for a machine that dialled in', () => {
    // What the server's mirror files this machine's branches under: the name it hands over.
    const from = mirrorMachine(machineLabel())
    const made = mergeProposal({
      project: 'tade',
      branch: 'main',
      from,
      head: 'a'.repeat(40),
      target: 'b'.repeat(40),
      ahead: 3,
      behind: 10,
      pushes: true,
    })
    const published = [
      `tade/${made.slug}`,
      made.title,
      made.prompt,
      made.context,
      mergeMessage(from, 'main'),
      mergeSlugStem('main'),
    ]
    for (const text of published) expect(hostNameIn(text), text).toBe(false)
    // And no machine at all in what becomes a branch: git's merge message names it.
    expect(made.slug).toBe(`merge-main-${'b'.repeat(7)}`)
  })

  it('is in no status posted back to a tracker, even one allowed to name the machine', () => {
    for (const saying of INTAKE_SAYINGS) {
      const text = intakeSays(saying, { names: true, task: 'tade/fix', machine: intakeMachine() })
      expect(hostNameIn(text), text).toBe(false)
    }
  })

  it("is in nothing telemetry sends, said in Tade's own words or not", () => {
    const said = scrub(`pushing to ${HOST}'s mirror, and serial7q2x-laptop-example's`, '')
    expect(hostNameIn(said), said).toBe(false)
  })

  it('is refused where a review is opened, in a branch, a title or a body', () => {
    expect(hostNameIn('tade/merge-serial7q2x-laptop-example-main-016b01a')).toBe(true)
    expect(hostNameIn(`Merge this machine's main and ${HOST}'s main`)).toBe(true)
    expect(hostNameIn('tade/merge-main-016b01a')).toBe(false)
  })

  it('is read in one file, and only to find what this machine was once called', () => {
    const readers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(path, 'utf8')
          if (/import \{[^}]*\bhostname\b[^}]*\} from 'node:os'/.test(text)) {
            readers.push(relative(ROOT, path))
          }
        }
      }
    }
    walk(join(ROOT, 'packages'))
    expect(readers).toEqual(['packages/core/src/remotes.ts'])
  })
})
