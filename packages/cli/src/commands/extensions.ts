import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultConfigPath,
  expandHome,
  extensionDirs,
  isExtensionName,
  loadable,
  loadConfig,
  wilcoHome,
} from '@wilco/core'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Reviewing the tools Wilco wrote for itself.
//
// An agent writes proposals; a human decides what runs. Nothing here activates
// anything on its own, and nothing takes effect until Wilco is started again —
// a hot-reloaded half-broken tool inside a running orchestrator is an evening
// lost.

async function root(configPath: string): Promise<string> {
  const cfg = await loadConfig(configPath)
  const configured = cfg.ok ? cfg.config.orchestrator.extensions : undefined
  return expandHome(configured ?? join(wilcoHome(), 'extensions'))
}

function list(dir: string): string[] {
  try {
    return loadable(readdirSync(dir))
  } catch {
    return []
  }
}

export function registerExtensions(
  program: Command,
  io: Io,
  setExit: (code: number) => void,
): void {
  const extensions = program
    .command('extensions')
    .description('Tools Wilco wrote for itself: what is proposed, and what runs')

  extensions
    .command('list', { isDefault: true })
    .description('What is active, proposed and turned down')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { config: string }) => {
      const dirs = extensionDirs(await root(opts.config))
      const active = list(dirs.active)
      const proposed = list(dirs.proposed)
      const rejected = list(dirs.rejected)

      io.out(`active    ${active.length ? active.join(', ') : '—'}`)
      io.out(`proposed  ${proposed.length ? proposed.join(', ') : '—'}`)
      io.out(`rejected  ${rejected.length ? rejected.join(', ') : '—'}`)
      if (proposed.length > 0) {
        io.out('')
        io.out(`read one in ${dirs.proposed}, then \`wilco extensions activate <name>\`.`)
      }
    })

  for (const [verb, from, to, done] of [
    ['activate', 'proposed', 'active', 'will load next time Wilco starts'],
    ['reject', 'proposed', 'rejected', 'kept, so it is not proposed again'],
  ] as const) {
    extensions
      .command(`${verb} <name>`)
      .description(
        verb === 'activate' ? 'Let a proposed tool run from now on' : 'Turn a proposed tool down',
      )
      .option('-c, --config <path>', 'config file path', defaultConfigPath())
      .action(async (name: string, opts: { config: string }) => {
        if (!isExtensionName(name)) {
          io.err(`${name} is not a name Wilco will use`)
          setExit(Exit.invalidInput)
          return
        }
        const dirs = extensionDirs(await root(opts.config))
        const source = join(dirs[from], `${name}.ts`)
        if (!existsSync(source)) {
          io.err(`nothing proposed called ${name}`)
          setExit(Exit.invalidInput)
          return
        }
        mkdirSync(dirs[to], { recursive: true })
        renameSync(source, join(dirs[to], `${name}.ts`))
        io.out(`${name} — ${done}`)
      })
  }
}
