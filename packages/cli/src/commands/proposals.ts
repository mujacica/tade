import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  activityFrom,
  defaultConfigPath,
  expandHome,
  extensionDirs,
  historyFrom,
  isExtensionName,
  loadable,
  loadableSkills,
  loadConfig,
  skillDirs,
  skillStanding,
  wilcoHome,
} from '@wilco/core'
import { activeSkills, loadExtensions } from '@wilco/orchestrator'
import { recordAuthored } from '@wilco/workbench'
import { readJournal } from '@wilco/workbench/events'
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
  dirs: (root: string) => { root: string; active: string; proposed: string; rejected: string }
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
    const files = kind.list(readdirSync(dir)).map((file) => file.replace(kind.ext, ''))
    // An extension of Wilco's own is a folder with an `extension.ts` in it.
    const folders =
      kind.noun === 'extensions'
        ? readdirSync(dir, { withFileTypes: true })
            .filter(
              (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'extension.ts')),
            )
            .map((entry) => `${entry.name}/`)
        : []
    return [...files, ...folders].sort((a, b) => a.localeCompare(b))
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
      if (kind.noun === 'extensions') {
        const cfg = await loadConfig(opts.config)
        if (cfg.ok) {
          const host = await loadExtensions({
            config: cfg.config,
            home: wilcoHome(),
            safe: program.opts().safe === true,
          })
          for (const one of host.list()) {
            io.out(`${one.title} (${one.name}, ${one.source}): ${one.state}`)
            if (one.problem) io.out(`  ${one.problem}`)
            if (one.tools.length > 0)
              io.out(`  tools: ${one.tools.map((tool) => tool.name).join(', ')}`)
            if (one.unknownSettings.length > 0) {
              io.out(
                `  not read: ${one.unknownSettings.map((key) => `extensions.${one.name}.${key}`).join(', ')}`,
              )
            }
          }
          io.out('')
        }
      }
      const show = (label: string, found: string[]) =>
        io.out(`${label.padEnd(10)}${found.length > 0 ? found.join(', ') : '—'}`)
      show('active', names(dirs.active, kind))
      // A lesson about something nobody has touched in a month is still
      // approved; it just is not said. Show which, and why, or it looks like
      // Wilco quietly forgot.
      if (kind.noun === 'skills') {
        const cfg = await loadConfig(opts.config)
        const quiet = skillStanding(
          activeSkills(dirs.root),
          activityFrom(
            historyFrom(await readJournal(wilcoHome(), { limit: 5_000 }), Date.now()),
            cfg.ok ? Object.keys(cfg.config.projects) : [],
          ),
          Date.now(),
        ).filter((standing) => standing.dormant)
        for (const standing of quiet) {
          io.out(`  ${standing.skill.name}: not being said — ${standing.reason}`)
        }
      }
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
        const file = join(dirs.proposed, `${name}${kind.ext}`)
        const folder = join(dirs.proposed, name)
        const source = existsSync(file)
          ? file
          : kind.noun === 'extensions' && existsSync(join(folder, 'extension.ts'))
            ? folder
            : null
        if (!source) {
          io.err(`nothing proposed called ${name}`)
          setExit(Exit.invalidInput)
          return
        }
        const target = to === 'active' ? dirs.active : dirs.rejected
        mkdirSync(target, { recursive: true })
        renameSync(source, join(target, source === file ? `${name}${kind.ext}` : name))
        // A decision about what Wilco may do to itself is worth a commit: the
        // question later is never "what is active" — the directory says that —
        // but "when did this start, and what was going on when I agreed".
        await recordAuthored(dirs.root, `${verb} ${kind.one} ${name}`)
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
  const group = program.commands.find((command) => command.name() === 'extensions')
  group
    ?.command('run <tool>')
    .description(
      "Run one of an extension's tools and print its answer: `wilco extensions run deps_check --project shop`",
    )
    .option('-p, --project <name>', 'the project it works on')
    .option('--input <json>', 'the rest of its input, as JSON', '{}')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (tool: string, opts: { project?: string; input: string; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      let input: Record<string, unknown>
      try {
        input = JSON.parse(opts.input) as Record<string, unknown>
      } catch {
        io.err('--input is not JSON')
        setExit(Exit.invalidInput)
        return
      }
      const host = await loadExtensions({
        config: cfg.config,
        home: wilcoHome(),
        safe: program.opts().safe === true,
      })
      try {
        // No window here, so a tool that starts an agent says it needs one.
        const answer = await host.call(
          tool,
          { ...input, ...(opts.project ? { project: opts.project } : {}) },
          { caller: { kind: 'you' }, wilco: null },
        )
        io.out(answer.text)
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      }
    })
}

export function registerSkills(program: Command, io: Io, setExit: (code: number) => void): void {
  register(program, io, setExit, SKILLS)
}
