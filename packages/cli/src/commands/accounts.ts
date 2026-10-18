import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  type Config,
  defaultConfigPath,
  loadConfig,
  runtimeDir,
  signInChosen,
  tadeHome,
  windowUsed,
} from '@tade/core'
import type { LaunchSpec } from '@tade/harnesses-core'
import type { Workbench } from '@tade/workbench'
// Subpath imports: the CLI must not load the driver stack to read who is signed in.
import { harnessAccount, listAccounts } from '@tade/workbench/accounts'
import { HARNESS_ADAPTERS } from '@tade/workbench/harnesses'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Who each harness's agents run as, from a terminal. A question, so it never
// needs the window: it asks each harness itself, which is what the Accounts
// page in Settings does too. Signing in runs the harness's own sign-in here,
// so what you give it goes where the harness keeps it and never through Tade.
//
// Adding, removing and choosing one are the workbench's own acts — the very
// ones the Accounts page calls — so they open it, and are refused while a
// window holds the home rather than writing a config that window would not
// read: there, Settings and the orchestrator are where it is done.

/** Where to ask instead, while a window holds the home. */
const THERE = 'Tade is open: do it in Settings › Accounts there, or ask the orchestrator'

/**
 * One of the workbench's own acts, from here. Loaded only when one is asked
 * for: listing who is signed in must not load the driver stack.
 */
async function acting(
  io: Io,
  setExit: (code: number) => void,
  act: (tade: Workbench) => Promise<void>,
): Promise<void> {
  const { withWorkbench } = await import('../with-workbench.ts')
  await withWorkbench(io, setExit, act, THERE)
}

function adapterFor(config: Config, home: string, harness: string, chosen: string | null) {
  const make = HARNESS_ADAPTERS[harness]
  if (!make)
    throw new Error(
      `no harness called ${harness}: there are ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
    )
  // The own sign-in by `default` or the name it was given.
  const name = signInChosen(config, harness, chosen)
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
        const called = view.name ?? view.ownName
        const name = `${view.harness}${called ? ` · ${called}` : ''}`
        const who = view.status.signedIn
          ? `signed in${view.status.who ? ` as ${view.status.who}` : ''}${view.status.plan ? ` (${view.status.plan})` : ''}`
          : (view.status.problem ?? 'not signed in')
        const shortest = view.limits?.windows[0]
        const used = shortest ? ` · ${windowUsed(shortest)}` : ''
        io.out(`${view.forNewAgents ? '▸' : ' '} ${name.padEnd(24)} ${who}${used}`)
        // The projects that run as it whatever the machine says.
        if (view.projects.length > 0) {
          io.out(`  ${''.padEnd(24)} new agents in ${view.projects.join(', ')}`)
        }
        // This machine's line for a harness that is not here, as setup says it.
        if (view.install) {
          const how = 'command' in view.install ? view.install.command : view.install.cannot
          io.out(`  ${''.padEnd(24)} ${how}`)
        }
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

  accounts
    .command('add <harness> <name>')
    .description(
      "Add an account beside a harness's own sign-in, in a folder of its own, then sign it in: `tade accounts add claude-code work`",
    )
    .option('--api-key', 'paid for with an API key rather than a subscription: set it in Settings')
    .option('--bare', 'start it without your own settings, skills and plugins')
    .action(async (harness: string, name: string, opts: { apiKey?: boolean; bare?: boolean }) => {
      let added = false
      await acting(io, setExit, async (tade) => {
        await tade.addAccount({
          name,
          harness,
          kind: opts.apiKey ? 'api-key' : 'subscription',
          share: !opts.bare,
        })
        added = true
      })
      if (!added) return
      const named = name.trim().toLowerCase()
      if (opts.apiKey) {
        io.out(`added ${named}: set its key in Settings › Accounts`)
        return
      }
      // Its own sign-in next, as Settings goes straight into it — here, where
      // somebody is at the keyboard, and said as a command where nobody is.
      if (!process.stdin.isTTY) {
        io.out(`added ${named}: sign it in with \`tade accounts sign-in ${harness} ${named}\``)
        return
      }
      const cfg = await loadConfig(defaultConfigPath())
      if (!cfg.ok) return
      const signing = adapterFor(cfg.config, tadeHome(), harness, named).signIn()
      if (!signing) return
      io.out(signing.how)
      setExit(await runHere(signing.launch))
    })

  accounts
    .command('remove <name>')
    .description(
      'Take an account away: signed out, its folder removed, and every project that named it back on the machine’s',
    )
    .action((name: string) =>
      acting(io, setExit, async (tade) => {
        await tade.removeAccount(name)
        io.out(`${name} is gone, and signed out`)
      }),
    )

  accounts
    .command('use <harness> [account]')
    .description(
      "Which account new agents of a harness run as — no account, or `default`, for its own sign-in; with --project, that project's, remembered over the machine's. An agent already working stays where it is",
    )
    .option('-p, --project <name>', "this project's new agents only")
    .option('--unset', "with --project: give the question back to the machine's answer")
    .action(
      (harness: string, account: string | undefined, opts: { project?: string; unset?: boolean }) =>
        acting(io, setExit, async (tade) => {
          if (opts.unset && opts.project === undefined)
            throw new Error('--unset is for a project: the machine has no answer above it')
          const name = opts.unset ? undefined : !account || account === 'default' ? null : account
          await tade.useAccount(harness, name, opts.project)
          const who = name === undefined ? 'as the machine does' : (name ?? 'its own sign-in')
          io.out(
            `new ${harness} agents${opts.project ? ` in ${opts.project}` : ''} run as ${who}; an agent already working stays on its own`,
          )
        }),
    )

  accounts
    .command('name <harness> [name]')
    .description(
      "Call a harness's own sign-in something, so it is shown and chosen by that name: `tade accounts name claude-code work`. It still signs in where the harness always does; no name takes it away",
    )
    .action((harness: string, name: string | undefined) =>
      acting(io, setExit, async (tade) => {
        const named = await tade.nameOwnSignIn(harness, name ?? null)
        io.out(
          named === null
            ? `${harness}'s own sign-in has no name`
            : `${harness}'s own sign-in is called ${named}; \`default\` still means it too`,
        )
      }),
    )

  signing('sign-in').description(
    "Sign a harness's account in with its own sign-in, in this terminal: `tade accounts sign-in claude-code work`",
  )
  signing('sign-out').description(
    "Sign a harness's account out: `tade accounts sign-out claude-code work`",
  )
}
