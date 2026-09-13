import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultConfigPath,
  expandHome,
  extensionDirs,
  isExtensionName,
  loadable,
  loadableSkills,
  loadConfig,
  skillDirs,
  wilcoHome,
} from '@wilco/core'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Reviewing what Wilco wrote for itself: tools, and lessons.
//
// Both work the same way and for the same reason. Wilco proposes; a human
// reads it and decides; nothing takes effect until Wilco is started again. A
// hot-reloaded half-broken tool inside a running orchestrator is an evening
// lost, and a lesson nobody read is a rule you did not agree to.

interface Kind {
  /** The command name, and how it reads in a sentence. */
  noun: string
  one: string
  ext: '.ts' | '.md'
  dirs: (root: string) => { active: string; proposed: string; rejected: string }
  list: (files: string[]) => string[]
  root: (configured: string | undefined) => string
  activated: string
}

const EXTENSIONS: Kind = {
  noun: 'extensions',
  one: 'tool',
  ext: '.ts',
  dirs: extensionDirs,
  list: loadable,
  root: (configured) => expandHome(configured ?? join(wilcoHome(), 'extensions')),
  activated: 'will load next time Wilco starts',
}

const SKILLS: Kind = {
  noun: 'skills',
  one: 'lesson',
  ext: '.md',
  dirs: skillDirs,
  list: loadableSkills,
  root: () => join(wilcoHome(), 'skills'),
  activated: 'will be in the prompt next time Wilco starts',
}

function names(dir: string, kind: Kind): string[] {
  try {
    return kind.list(readdirSync(dir)).map((file) => file.replace(kind.ext, ''))
  } catch {
    return []
  }
}

async function rootFor(kind: Kind, configPath: string): Promise<string> {
  const cfg = await loadConfig(configPath)
  return kind.root(cfg.ok ? cfg.config.orchestrator.extensions : undefined)
}

function register(program: Command, io: Io, setExit: (code: number) => void, kind: Kind): void {
  const group = program
    .command(kind.noun)
    .description(
      kind.noun === 'skills'
        ? 'Lessons Wilco wrote for itself: what is proposed, and what it goes by'
        : 'Tools Wilco wrote for itself: what is proposed, and what runs',
    )

  group
    .command('list', { isDefault: true })
    .description('What is active, proposed and turned down')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const dirs = kind.dirs(await rootFor(kind, opts.config))
      const show = (label: string, found: string[]) =>
        io.out(`${label.padEnd(10)}${found.length > 0 ? found.join(', ') : '—'}`)
      show('active', names(dirs.active, kind))
      const proposed = names(dirs.proposed, kind)
      show('proposed', proposed)
      show('rejected', names(dirs.rejected, kind))
      if (proposed.length > 0) {
        io.out('')
        io.out(`read one in ${dirs.proposed}, then \`wilco ${kind.noun} activate <name>\`.`)
      }
    })

  for (const [verb, to, done] of [
    ['activate', 'active', kind.activated],
    ['reject', 'rejected', 'kept, so it is not proposed again'],
  ] as const) {
    group
      .command(`${verb} <name>`)
      .description(
        verb === 'activate'
          ? `Let a proposed ${kind.one} count`
          : `Turn a proposed ${kind.one} down`,
      )
      .option('-c, --config <path>', 'config file path', defaultConfigPath())
      .action(async (name: string, opts: { config: string }) => {
        if (!isExtensionName(name)) {
          io.err(`${name} is not a name Wilco will use`)
          setExit(Exit.invalidInput)
          return
        }
        const dirs = kind.dirs(await rootFor(kind, opts.config))
        const source = join(dirs.proposed, `${name}${kind.ext}`)
        if (!existsSync(source)) {
          io.err(`nothing proposed called ${name}`)
          setExit(Exit.invalidInput)
          return
        }
        const target = to === 'active' ? dirs.active : dirs.rejected
        mkdirSync(target, { recursive: true })
        renameSync(source, join(target, `${name}${kind.ext}`))
        io.out(`${name} — ${done}`)
      })
  }
}

export function registerExtensions(
  program: Command,
  io: Io,
  setExit: (code: number) => void,
): void {
  register(program, io, setExit, EXTENSIONS)
}

export function registerSkills(program: Command, io: Io, setExit: (code: number) => void): void {
  register(program, io, setExit, SKILLS)
}
