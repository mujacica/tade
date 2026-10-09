import {
  ConfigSchema,
  INTAKE_SETUP,
  INTAKE_SOURCES,
  intakeUnfinished,
  settingsOf,
} from '@tade/core'
import { describe, expect, it } from 'vitest'

// What turning a source on takes, and whether somebody has finished doing it.
//
// Two things are worth a test here and neither is the prose. The first is that
// **every source has steps**, because the type holds that only while somebody
// keeps the record literal and a source nobody can work out how to turn on is a
// source nobody turns on. The second is that **the steps name keys that
// exist**: instructions are the one kind of documentation that rots silently,
// and a step naming a setting that has since moved is worse than no step,
// because somebody will write it into their config and wait.

/** Every `surfaces.intake…` path Settings actually offers. */
const offered = new Set(
  settingsOf(ConfigSchema.parse({}))
    .flatMap((group) => group.settings)
    .map((one) => one.path)
    .filter((path) => path.startsWith('surfaces.intake')),
)

/** Every dotted `surfaces.intake…` path the steps name, by source. */
function named(steps: readonly string[]): string[] {
  return steps.flatMap((step) => [...step.matchAll(/surfaces\.intake[\w.]*/g)].map((one) => one[0]))
}

describe('what turning a source on takes', () => {
  it('has steps for every source there is, each a line somebody can read', () => {
    for (const source of INTAKE_SOURCES) {
      const steps = INTAKE_SETUP[source]
      expect(steps.length, source).toBeGreaterThan(2)
      for (const step of steps) {
        expect(step.trim(), source).toBe(step)
        expect(step.length, step).toBeGreaterThan(10)
      }
      // The grant is three decisions and the steps have to name all three, or
      // somebody follows them and nothing arrives: accept, the projects, the
      // people. `from: []` means nobody, which is the one a step that only
      // said "turn it on" would leave somebody waiting on.
      const says = steps.join(' ')
      for (const key of ['accept', 'projects', 'from']) {
        expect(says, `${source}: ${key}`).toContain(`sources.${source}.${key}`)
      }
    }
  })

  it('names only settings that exist, so a step cannot send somebody to a key that moved', () => {
    for (const source of INTAKE_SOURCES) {
      const paths = named(INTAKE_SETUP[source])
      expect(paths.length, source).toBeGreaterThan(0)
      for (const path of paths) {
        // Trailing punctuation is prose, not path.
        expect(offered, `${source} names ${path}`).toContain(path.replace(/[.:]$/, ''))
      }
    }
  })

  it('names no key of another source, which is how somebody writes the wrong grant', () => {
    for (const source of INTAKE_SOURCES) {
      for (const path of named(INTAKE_SETUP[source])) {
        const other = INTAKE_SOURCES.find(
          (each) => each !== source && path.startsWith(`surfaces.intake.sources.${each}.`),
        )
        expect(other, `${source} names ${path}`).toBeUndefined()
      }
    }
  })
})

describe('whether somebody has finished writing a grant', () => {
  const grant = (over: Partial<Parameters<typeof intakeUnfinished>[0]> = {}) => ({
    on: true,
    accept: true,
    projects: ['app'],
    from: ['kim'],
    ...over,
  })

  it('says nothing about a grant that would work', () => {
    expect(intakeUnfinished(grant())).toBeNull()
  })

  it('names each of the four things that stop one, and only the first of them', () => {
    // Cheapest first, and one at a time: four reasons at once is a wall, and
    // the surface the whole of it is off is not the surface one source is.
    expect(intakeUnfinished(grant({ on: false }))).toBe('surfaces.intake.enabled is off')
    expect(intakeUnfinished(grant({ accept: false }))).toBe('accept is off')
    expect(intakeUnfinished(grant({ projects: [] }))).toBe('no project is on its list')
    expect(intakeUnfinished(grant({ from: [] }))).toBe('nobody is on its list')
    // The surface being off is said rather than the source's own first miss,
    // because turning the source on would still change nothing.
    expect(intakeUnfinished(grant({ on: false, accept: false, projects: [], from: [] }))).toBe(
      'surfaces.intake.enabled is off',
    )
  })

  it('reads an empty allowlist as unfinished rather than as a decision', () => {
    // `from: []` is a grant that parses, is on, and can never accept anything.
    // Read as finished it would be a source that looks ready and is a hole in
    // the other direction: silent, for ever.
    const parsed = ConfigSchema.parse({
      surfaces: {
        intake: { enabled: true, sources: { cli: { accept: true, projects: ['app'] } } },
      },
    })
    const cli = parsed.surfaces.intake.sources.cli
    expect(cli.from).toEqual([])
    expect(
      intakeUnfinished({
        on: parsed.surfaces.intake.enabled,
        accept: cli.accept,
        projects: cli.projects,
        from: cli.from,
      }),
    ).toBe('nobody is on its list')
  })
})
