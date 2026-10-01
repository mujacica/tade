import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  activityFrom,
  type Config,
  defaultConfigPath,
  expandHome,
  extensionEnabled,
  historyFrom,
  isExtensionName,
  loadableSkills,
  loadConfig,
  skillDirs,
  skillStanding,
  tadeHome,
  writeSetting,
} from '@tade/core'
import type { LoadedExtension } from '@tade/extensions-core'
import { activeSkills, brokerFor, loadExtensions, writtenTools } from '@tade/orchestrator'
import { recordAuthored } from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// What Tade wrote for itself: tools, and lessons.
//
// A tool lives in the extensions directory with every other extension and is
// off until somebody turns it on; turning one on takes effect the next time
// Tade starts, because a hot-reloaded half-broken tool inside a running
// orchestrator is an evening lost. A lesson still waits in `proposed/` until
// it is read, because a lesson nobody read is a rule you did not agree to.

const SKILLS = {
  root: () => join(tadeHome(), 'skills'),
  activated: 'will be in the prompt next time Tade starts',
}

/** The lessons in one directory, by name. Never throws: no directory is none. */
function skillNames(dir: string): string[] {
  try {
    return loadableSkills(readdirSync(dir))
      .map((file) => file.replace('.md', ''))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * The server of this name, said the way a server is named (`github`, never
 * `mcp-github`). Null when nothing declared one.
 */
function mcpServer(name: string, config: Config): string | null {
  const known = brokerFor({ config, home: tadeHome() }).servers
  return known.some((one) => one.declaration.name === name) ? name : null
}

export function registerExtensions(
  program: Command,
  io: Io,
  setExit: (code: number) => void,
): void {
  const group = program
    .command('extensions')
    .description('Extensions: what is on, what is off, and what each of them can do')

  group
    .command('list', { isDefault: true })
    .description('What is loaded, what it needs, and what is sitting there turned off')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const safe = program.opts().safe === true
      const host = await loadExtensions({
        config: cfg.config,
        home: tadeHome(),
        safe,
        configPath: opts.config,
      })
      const say = (one: LoadedExtension) => {
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
      for (const one of host.list()) {
        if (one.source !== 'mcp') say(one)
      }
      // Under their own heading, because a server is not an extension however
      // it is implemented — and turning one on is its own command.
      const servers = host.list().filter((one) => one.source === 'mcp')
      if (servers.length > 0) {
        io.out('')
        io.out('MCP servers you turned on (`tade mcp list` says which there are):')
        for (const one of servers) say(one)
      }
      // The single-file tools the orchestrator loads. They are not the
      // window's to hold, so the host does not list them: they are listed
      // here, beside the rest, because there is one folder now.
      const tools = writtenTools(expandHome(cfg.config.orchestrator.extensions))
      if (tools.length > 0) {
        io.out('')
        io.out('tools for the orchestrator, written by Tade:')
        for (const tool of tools) {
          const on = !safe && extensionEnabled(cfg.config.extensions[tool.name], 'yours')
          const state = on ? 'on' : safe ? 'off, left out by --safe' : 'off'
          io.out(`  ${tool.name}: ${state}${tool.why ? ` — ${tool.why}` : ''}`)
          io.out(`    ${tool.path}`)
        }
      }
      // Only the ones nobody has decided about: something you turned off is
      // not something waiting for you.
      const undecided = [...host.list().filter((one) => one.source === 'yours'), ...tools].filter(
        (one) => cfg.config.extensions[one.name]?.enabled === undefined,
      )
      if (undecided.length > 0) {
        io.out('')
        io.out(
          'read one, then `tade extensions enable <name>`. It loads the next time Tade starts.',
        )
      }
    })

  group
    .command('enable <name>')
    .alias('activate')
    .description(
      'Turn an extension on — it loads the next time Tade starts (`activate` is the old name for this)',
    )
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action((name: string, opts: { config: string }) => turn(name, opts.config, true))

  group
    .command('disable <name>')
    .description('Turn an extension off — it stops loading the next time Tade starts')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action((name: string, opts: { config: string }) => turn(name, opts.config, false))

  /**
   * Turning one on or off is a setting, not a move: what is on is written
   * down where every other answer about this machine is, and the directory
   * says nothing about it.
   */
  async function turn(name: string, configPath: string, on: boolean): Promise<void> {
    if (!isExtensionName(name)) {
      io.err(`${name} is not a name Tade will use`)
      setExit(Exit.invalidInput)
      return
    }
    const cfg = await loadConfig(configPath)
    if (!cfg.ok) {
      io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
      setExit(Exit.invalidInput)
      return
    }
    // One switch, and no ambiguity about which. `mcp-<server>` is the name of
    // the extension a server becomes, and its switch is the server's: it was
    // only ever handed over because the server is on, so `extensions.mcp-<it>`
    // is not a second question and turning it on here would do nothing.
    const brokered = name.startsWith('mcp-')
      ? mcpServer(name.slice('mcp-'.length), cfg.config)
      : null
    if (brokered) {
      io.err(`that is an MCP server: \`tade mcp ${on ? 'enable' : 'disable'} ${brokered}\``)
      setExit(Exit.invalidInput)
      return
    }
    const root = expandHome(cfg.config.orchestrator.extensions)
    const known =
      existsSync(join(root, name, 'extension.ts')) ||
      writtenTools(root).some((tool) => tool.name === name) ||
      (await loadExtensions({ config: cfg.config, home: tadeHome(), configPath }))
        .list()
        .some((one) => one.name === name)
    // A bare name is the extension's whenever there is an extension of that
    // name: Tade's own Sentry extension and the catalogue's Sentry server are
    // both `sentry`, and answering with the server left the extension with no
    // way to be turned on at all. It is only the server's when no extension
    // answers to it, which is the redirect somebody reaching for `github` wants.
    if (!known) {
      const server = mcpServer(name, cfg.config)
      io.err(
        server
          ? `that is an MCP server: \`tade mcp ${on ? 'enable' : 'disable'} ${server}\``
          : `there is no extension called ${name}`,
      )
      setExit(Exit.invalidInput)
      return
    }
    writeSetting(configPath, `extensions.${name}.enabled`, on)
    // A decision about what Tade may do to itself is worth a commit: the
    // question later is never "what is on" — the config says that — but "when
    // did this start, and what was going on when I agreed".
    await recordAuthored(root, `${on ? 'enable' : 'disable'} extension ${name}`)
    io.out(
      on
        ? `${name} is on — it loads the next time Tade starts`
        : `${name} is off — it stops loading the next time Tade starts`,
    )
  }

  group
    .command('run <tool>')
    .description(
      "Run one of an extension's tools and print its answer: `tade extensions run deps_check --project shop`",
    )
    .option('-p, --project <name>', 'the project it works on')
    .option('--input <json>', 'the rest of its input, as JSON', '{}')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (tool: string, opts: { project?: string; input: string; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
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
        home: tadeHome(),
        safe: program.opts().safe === true,
        configPath: opts.config,
      })
      try {
        // No window here, so a tool that starts an agent says it needs one.
        const answer = await host.call(
          tool,
          { ...input, ...(opts.project ? { project: opts.project } : {}) },
          { caller: { kind: 'you' }, tade: null },
        )
        io.out(answer.text)
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(Exit.error)
      }
    })
}

export function registerSkills(program: Command, io: Io, setExit: (code: number) => void): void {
  const group = program
    .command('skills')
    .description('Lessons Tade wrote for itself: what is proposed, and what it goes by')

  group
    .command('list', { isDefault: true })
    .description('What is active, proposed and turned down')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const dirs = skillDirs(SKILLS.root())
      const show = (label: string, found: string[]) =>
        io.out(`${label.padEnd(10)}${found.length > 0 ? found.join(', ') : '—'}`)
      show('active', skillNames(dirs.active))
      // A lesson about something nobody has touched in a month is still
      // approved; it just is not said. Show which, and why, or it looks like
      // Tade quietly forgot.
      const cfg = await loadConfig(opts.config)
      const quiet = skillStanding(
        activeSkills(dirs.root),
        activityFrom(
          historyFrom(await readJournal(tadeHome(), { limit: 5_000 }), Date.now()),
          cfg.ok ? Object.keys(cfg.config.projects) : [],
        ),
        Date.now(),
      ).filter((standing) => standing.dormant)
      for (const standing of quiet) {
        io.out(`  ${standing.skill.name}: not being said — ${standing.reason}`)
      }
      const proposed = skillNames(dirs.proposed)
      show('proposed', proposed)
      show('rejected', skillNames(dirs.rejected))
      if (proposed.length > 0) {
        io.out('')
        io.out(`read one in ${dirs.proposed}, then \`tade skills activate <name>\`.`)
      }
    })

  for (const [verb, done] of [
    ['activate', SKILLS.activated],
    ['reject', 'kept, so it is not proposed again'],
  ] as const) {
    group
      .command(`${verb} <name>`)
      .description(
        verb === 'activate' ? 'Let a proposed lesson count' : 'Turn a proposed lesson down',
      )
      .action(async (name: string) => {
        if (!isExtensionName(name)) {
          io.err(`${name} is not a name Tade will use`)
          setExit(Exit.invalidInput)
          return
        }
        const dirs = skillDirs(SKILLS.root())
        const source = join(dirs.proposed, `${name}.md`)
        if (!existsSync(source)) {
          io.err(`nothing proposed called ${name}`)
          setExit(Exit.invalidInput)
          return
        }
        const target = verb === 'activate' ? dirs.active : dirs.rejected
        mkdirSync(target, { recursive: true })
        renameSync(source, join(target, `${name}.md`))
        // A decision about what Tade may do to itself is worth a commit: the
        // question later is never "what is active" — the directory says that
        // — but "when did this start, and what was going on when I agreed".
        await recordAuthored(dirs.root, `${verb} lesson ${name}`)
        io.out(`${name} — ${done}`)
      })
  }
}
