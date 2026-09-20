import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { type Config, defaultConfigPath, loadConfig, runtimeDir, tadeHome } from '@tade/core'
import type { LaunchSpec } from '@tade/harnesses-core'
// Subpath imports: the CLI must not load the driver stack to read who is signed in.
import { harnessAccount, listAccounts } from '@tade/workbench/accounts'
import { HARNESS_ADAPTERS } from '@tade/workbench/harnesses'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Who each harness's agents run as, from a terminal. A question, so it never
// needs the window: it asks each harness itself, which is what the Accounts
// page in Settings does too. Signing in runs the harness's own sign-in here,
// so what you give it goes where the harness keeps it and never through Tade.
// Adding, removing and choosing accounts is done in Settings.

function adapterFor(config: Config, home: string, harness: string, name: string | null) {
  const make = HARNESS_ADAPTERS[harness]
  if (!make)
    throw new Error(
      `no harness called ${harness}: there are ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
    )
  if (name && config.accounts[name]?.harness !== harness) {
    throw new Error(`no ${harness} account called ${name}`)
  }
  return make({
    runDir: join(home, 'runs'),
    socketDir: runtimeDir(home),
    approvals: config.approvals.mode,
    ...(name ? { account: harnessAccount(config, home, name) } : {}),
  })
}

/** Run a harness's own sign-in in this terminal, handing it the keyboard. */
function runHere(launch: LaunchSpec): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      stdio: 'inherit',
      env: { ...process.env, ...launch.env },
    })
    child.on('exit', (code) => resolve(code ?? Exit.error))
    child.on('error', () => resolve(Exit.error))
  })
}

export function registerAccounts(program: Command, io: Io, setExit: (code: number) => void): void {
  const accounts = program
    .command('accounts')
    .description(
      "Who each harness's agents run as: its own sign-in, and accounts added beside it in Settings",
    )
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { json?: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const home = tadeHome()
      const views = await listAccounts(cfg.config, {
        adapterFor: (harness, name) => adapterFor(cfg.config, home, harness, name),
      })
      if (opts.json) {
        io.out(JSON.stringify(views, null, 2))
        return
      }
      for (const view of views) {
        const name = `${view.harness}${view.name ? ` · ${view.name}` : ''}`
        const who = view.status.signedIn
          ? `signed in${view.status.who ? ` as ${view.status.who}` : ''}${view.status.plan ? ` (${view.status.plan})` : ''}`
          : (view.status.problem ?? 'not signed in')
        const used = view.limits?.fiveHour
          ? ` · ${Math.round(view.limits.fiveHour.used)}% of 5h`
          : ''
        io.out(`${view.forNewAgents ? '▸' : ' '} ${name.padEnd(24)} ${who}${used}`)
      }
    })

  const signing = (verb: 'sign-in' | 'sign-out') =>
    accounts
      .command(`${verb} <harness> [account]`)
      .option('-c, --config <path>', 'config file path', defaultConfigPath())
      .action(async (harness: string, name: string | undefined, opts: { config: string }) => {
        const cfg = await loadConfig(opts.config)
        if (!cfg.ok) {
          io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
          setExit(Exit.invalidInput)
          return
        }
        try {
          const adapter = adapterFor(cfg.config, tadeHome(), harness, name ?? null)
          if (verb === 'sign-out') {
            await adapter.signOut()
            io.out(`signed ${name ?? harness} out`)
            return
          }
          const signing = adapter.signIn()
          if (!signing) {
            io.err(`${name ?? harness} is paid for with an API key: set it in Settings, Accounts`)
            setExit(Exit.invalidInput)
            return
          }
          io.out(signing.how)
          setExit(await runHere(signing.launch))
        } catch (err) {
          io.err((err as Error).message)
          setExit(Exit.invalidInput)
        }
      })

  signing('sign-in').description(
    "Sign a harness's account in with its own sign-in, in this terminal: `tade accounts sign-in claude-code work`",
  )
  signing('sign-out').description(
    "Sign a harness's account out: `tade accounts sign-out claude-code work`",
  )
}
