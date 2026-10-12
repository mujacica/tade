import type { ProgramLook, UpdateLook } from '@tade/workbench/programs'

// What an Updates look would have read, built small: a Tade and the programs
// named, each with a command or the reason there is none. The tests about the
// strip's chip, a run and the orchestrator's tools all start from one.

/** One program, behind or not, with the command that moves it or none. */
export function program(
  command: string,
  over: { title?: string; behind?: boolean; run?: string | null; version?: string } = {},
): ProgramLook {
  const run = over.run === undefined ? `brew upgrade ${command}` : over.run
  return {
    need: {
      command,
      title: over.title ?? command,
      versionArgs: ['--version'],
      optional: false,
      needed: [{ what: 'Tade', why: 'it is needed', inUse: true }],
      inUse: true,
    },
    install: {
      manager: 'homebrew',
      name: command,
      where: `/opt/homebrew/bin/${command}`,
      said: 'Homebrew',
      brew: 'formula',
    },
    version: over.version ?? '1.0.0',
    latest: over.behind ? '1.1.0' : '1.0.0',
    cannotTell: null,
    update: run === null ? { cannot: 'nobody can say how' } : { command: run },
    behind: over.behind === true,
  }
}

/** A whole look: Tade, behind or not, and the programs. */
export function lookWith(
  over: {
    programs?: ProgramLook[]
    tadeNewer?: boolean
    tadeRun?: string | null
    commit?: string
    asked?: boolean
    at?: number
  } = {},
): UpdateLook {
  const run = over.tadeRun === undefined ? 'git -C ~/src/tade pull --ff-only' : over.tadeRun
  return {
    at: over.at ?? 0,
    asked: over.asked ?? true,
    tade: {
      version: '0.1.0',
      from: 'checkout',
      where: '~/src/tade',
      branch: 'main',
      commit: over.commit ?? 'f8d73e1',
      install: null,
      newer: over.tadeNewer ? 'origin/main is at 1a2b3c4 and this checkout is on f8d73e1' : null,
      cannotTell: null,
      update:
        run === null ? { cannot: 'this checkout follows no remote branch' } : { command: run },
    },
    programs: over.programs ?? [],
  }
}
