import {
  type Config,
  defaultConfigPath,
  expandHome,
  loadConfig,
  MCP_TRANSPORT_NAMES,
  tadeHome,
  writeSetting,
} from '@tade/core'
import { type DeclaredServer, readCache, serverNameProblem } from '@tade/mcp-core'
import { brokerFor } from '@tade/orchestrator'
import { recordAuthored } from '@tade/workbench'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// The MCP servers, from a terminal: what this machine is set up to reach,
// what each of them would need, and turning one on.
//
// Everything here but `probe` reads files — the config, the catalogue in
// code, and what each server offered last time anybody asked — so it all
// works with the window open, the way every other question does. `probe` is
// the one that dials, and it says so.
//
// Turning one on is a person's act and only ever a person's: an agent that
// could enable a server could grant itself tools, and the orchestrator reads
// attacker-controlled text all day. There is no tool for it, here or anywhere.

/** One server as the config schema takes it: the one reader there is, so the one shape. */
type Declared = NonNullable<Config['mcp']['servers'][string]>

export function registerMcp(program: Command, io: Io, setExit: (code: number) => void): void {
  const group = program
    .command('mcp')
    .description('MCP servers: what Tade can reach, what each needs, and which are on')

  const read = async (path: string) => {
    const cfg = await loadConfig(path)
    if (!cfg.ok) {
      io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
      setExit(Exit.invalidInput)
      return null
    }
    return cfg.config
  }

  /** Every server Tade has been told about, the catalogue's among them. */
  const all = async (path: string): Promise<DeclaredServer[] | null> => {
    const config = await read(path)
    if (!config) return null
    // Through the broker, because which transports there are is its registry
    // to say — and a kind of server Tade cannot talk to yet is a sentence on
    // a row rather than a thing missing from the list.
    return [...brokerFor({ config, home: tadeHome() }).servers]
  }

  group
    .command('list', { isDefault: true })
    .description('Every server Tade knows about: what it is, whether it is on, and what it needs')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { json?: boolean; config: string }) => {
      const servers = await all(opts.config)
      if (!servers) return
      const home = tadeHome()
      if (opts.json) {
        io.out(
          JSON.stringify(
            servers.map((server) => ({
              name: server.declaration.name,
              on: server.declaration.enabled,
              from: server.from,
              transport: server.declaration.transport,
              problem: server.problem,
              tools: (readCache(home, server.declaration.name)?.tools ?? []).length,
            })),
            null,
            2,
          ),
        )
        return
      }
      for (const server of servers) {
        const { name, enabled } = server.declaration
        const cache = readCache(home, name)
        const tools = cache ? `, ${cache.tools.length} tools` : ''
        io.out(`${enabled ? '●' : '○'} ${name} (${server.declaration.transport}${tools})`)
        if (server.description) io.out(`  ${server.description}`)
        if (server.problem) io.out(`  ${server.problem}`)
        if (server.declaration.install) io.out(`  to install: ${server.declaration.install}`)
      }
      const undecided = servers.filter((server) => !server.declaration.enabled)
      if (undecided.length > 0) {
        io.out('')
        io.out(
          'read one, then `tade mcp enable <name>`. It connects the next time Tade starts, and its tools reach every agent and the orchestrator.',
        )
      }
    })

  group
    .command('add <name>')
    .description('Write down a server of your own. It is off until you turn it on')
    .option('--transport <kind>', MCP_TRANSPORT_NAMES.join(', '))
    .option('--command <program>', 'the program Tade starts, for a stdio server')
    .option('--args <args...>', 'what that program is started with')
    .option('--url <url>', 'where an http or sse server answers')
    .option('--auth <how>', 'none, env, bearer or header')
    .option('--auth-name <name>', 'the variable or header its credential goes in')
    .option('--key-env <variable>', 'the environment variable your key is already in')
    .option('--scope <scope>', 'window (the default) or project')
    .option('--about <line>', 'what you turned it on for, in a line')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(
      async (
        name: string,
        opts: {
          transport?: string
          command?: string
          args?: string[]
          url?: string
          auth?: string
          authName?: string
          keyEnv?: string
          scope?: string
          about?: string
          config: string
        },
      ) => {
        const named = serverNameProblem(name)
        if (named) {
          io.err(named)
          setExit(Exit.invalidInput)
          return
        }
        const config = await read(opts.config)
        if (!config) return
        const transport = opts.transport as Declared['transport']
        // Against the one list the schema reads, so nothing here writes a
        // word that would stop the config from loading.
        if (opts.transport && !MCP_TRANSPORT_NAMES.includes(transport as never)) {
          io.err(
            `there is no transport called ${opts.transport}: ${MCP_TRANSPORT_NAMES.join(', ')}`,
          )
          setExit(Exit.invalidInput)
          return
        }
        const written: Declared = {
          ...(transport ? { transport } : {}),
          ...(opts.command ? { command: opts.command } : {}),
          ...(opts.args ? { args: opts.args } : {}),
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.auth ? { auth: opts.auth as Declared['auth'] } : {}),
          ...(opts.authName ? { auth_name: opts.authName } : {}),
          ...(opts.keyEnv ? { key_env: opts.keyEnv } : {}),
          ...(opts.scope ? { scope: opts.scope as Declared['scope'] } : {}),
          ...(opts.about ? { about: opts.about } : {}),
        }
        // Checked against the catalogue before it is written: a declaration
        // that cannot work is said now, rather than found on a page later.
        const server = brokerFor({
          config: {
            ...config,
            mcp: { servers: { ...config.mcp.servers, [name]: written } },
          },
          home: tadeHome(),
        }).servers.find((one) => one.declaration.name === name)
        if (server?.problem) {
          io.err(server.problem)
          setExit(Exit.invalidInput)
          return
        }
        writeSetting(opts.config, `mcp.servers.${name}`, { ...written })
        io.out(
          `${name} is written down, and off — a server is somebody else's code with tools your agents will call.`,
        )
        io.out(`turn it on with \`tade mcp enable ${name}\`.`)
      },
    )

  for (const [verb, on] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    group
      .command(`${verb} <name>`)
      .description(
        on
          ? 'Turn a server on — it connects the next time Tade starts, and every harness gets its tools'
          : 'Turn a server off — its session ends and its tools stop being offered',
      )
      .option('-c, --config <path>', 'config file path', defaultConfigPath())
      .action(async (name: string, opts: { config: string }) => {
        const servers = await all(opts.config)
        if (!servers) return
        const server = servers.find((one) => one.declaration.name === name)
        if (!server) {
          io.err(
            `there is no server called ${name}: \`tade mcp list\` says which there are, and \`tade mcp add ${name}\` writes one down`,
          )
          setExit(Exit.invalidInput)
          return
        }
        if (on && server.problem) {
          io.err(`${name} cannot work as it stands: ${server.problem}`)
          setExit(Exit.invalidInput)
          return
        }
        writeSetting(opts.config, `mcp.servers.${name}.enabled`, on)
        // A decision about what your agents may call is worth a commit: the
        // question later is never "what is on" — the config says that — but
        // "when did this start, and what was going on when I agreed".
        const config = await read(opts.config)
        if (config) {
          await recordAuthored(
            expandHome(config.orchestrator.extensions),
            `${on ? 'enable' : 'disable'} MCP server ${name}`,
          )
        }
        io.out(
          on
            ? `${name} is on — it connects the next time Tade starts, and its tools are offered to every agent and the orchestrator`
            : `${name} is off — its session ends and its tools stop being offered`,
        )
      })
  }

  group
    .command('probe <name>')
    .description('Ask a server what it offers, now — the one thing here that dials it')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (name: string, opts: { config: string }) => {
      const config = await read(opts.config)
      if (!config) return
      const home = tadeHome()
      // Asked as if it were on, because that is the question: what would this
      // offer? Nothing about the config changes, and nothing else is opened.
      const mcp = brokerFor({
        config: {
          ...config,
          mcp: { servers: { [name]: { ...config.mcp.servers[name], enabled: true } } },
        },
        home,
        onWarning: (message) => io.err(message),
      })
      const server = mcp.servers.find((one) => one.declaration.name === name)
      if (!server) {
        io.err(`there is no server called ${name}`)
        setExit(Exit.invalidInput)
        return
      }
      if (server.problem) {
        io.err(server.problem)
        setExit(Exit.invalidInput)
        return
      }
      try {
        await mcp.warm()
      } finally {
        await mcp.close().catch(() => {})
      }
      const cache = readCache(home, name)
      if (!cache) {
        // The warning said what went wrong; this says what it means.
        io.err(`${name} did not say what it offers`)
        setExit(Exit.error)
        return
      }
      io.out(`${cache.about.title} ${cache.about.version}`.trim())
      io.out(`asked ${cache.asked}`)
      for (const tool of cache.tools) io.out(`  ${tool.name}`)
      if (cache.tools.length === 0) io.out('  it offers no tools Tade can hand on')
    })
}
