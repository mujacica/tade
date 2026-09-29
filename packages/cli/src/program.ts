import { homedir } from 'node:os'
import { defaultConfigPath, loadConfig, tadeHome } from '@tade/core'
import { collectStatus } from '@tade/status'
// Subpath imports: the CLI must not load the driver stack just to read status.
import { laneLivenessFromFile } from '@tade/workbench/lane-liveness'
import { Command, CommanderError } from 'commander'
import { registerAccounts } from './commands/accounts.ts'
import { registerApp } from './commands/app.ts'
import { registerBrief } from './commands/brief.ts'
import { registerChat } from './commands/chat.ts'
import { registerCheck } from './commands/check.ts'
import { registerChecks } from './commands/checks.ts'
import { registerConfig } from './commands/config.ts'
import { registerLanes } from './commands/lanes.ts'
import { registerMcp } from './commands/mcp.ts'
import { registerNotes } from './commands/notes.ts'
import { registerExtensions, registerSkills } from './commands/proposals.ts'
import { registerSchedules } from './commands/schedules.ts'
import { registerSetup } from './commands/setup.ts'
import { registerSpend } from './commands/spend.ts'
import { registerSummary } from './commands/summary.ts'
import { registerTasks } from './commands/tasks.ts'
import { registerUpdate } from './commands/update.ts'
import { registerVoice } from './commands/voice.ts'
import { formatStatus } from './format.ts'
import { defaultIo, Exit, type Io } from './io.ts'
import { reportCrash } from './telemetry.ts'
import { version } from './version.ts'

export { Exit, type Io } from './io.ts'

export function buildProgram(io: Io, setExit: (code: number) => void): Command {
  const program = new Command('tade')
    .description(
      'A voice-first control room for running coding agents on your own machine.\n' +
        'Run it with no arguments to open the window.',
    )
    .version(version())
    // The way back when a self-written tool is what broke. It must not depend
    // on any of them, so it is a flag on the root and nothing else.
    .option('--safe', 'start with none of the self-written extensions loaded')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s.trimEnd()),
      writeErr: (s) => io.err(s.trimEnd()),
    })

  program
    .command('status')
    .description('Where are we: every task, derived fresh from git, processes and transcripts')
    .option('--json', 'machine-readable output')
    .option('--no-pr', 'skip PR lookups via gh (they hit the network)')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { json?: boolean; pr: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      // Read the lanes rather than take the workbench: status is a question,
      // and asking it must never wait on, or interfere with, an open window.
      const liveness = await laneLivenessFromFile(tadeHome())
      const ws = await collectStatus({
        config: cfg.config,
        now: Date.now(),
        home: homedir(),
        tadeHome: tadeHome(),
        cwd: process.cwd(),
        pr: opts.pr && process.env.TADE_NO_GH !== '1',
        liveness,
      })
      if (opts.json) io.out(JSON.stringify(ws, null, 2))
      else for (const line of formatStatus(ws)) io.out(line)
    })

  registerConfig(program, io, setExit)
  registerSetup(program, io, setExit)
  registerApp(program, io, setExit)
  registerBrief(program, io, setExit)
  registerChat(program, io, setExit)
  registerCheck(program, io, setExit)
  registerAccounts(program, io, setExit)
  registerChecks(program, io, setExit)
  registerTasks(program, io, setExit)
  registerLanes(program, io, setExit)
  registerNotes(program, io, setExit)
  registerSpend(program, io)
  registerSchedules(program, io)
  registerSummary(program, io, setExit)
  registerVoice(program, io, setExit)
  registerUpdate(program, io, setExit)
  registerExtensions(program, io, setExit)
  registerMcp(program, io, setExit)
  registerSkills(program, io, setExit)
  return program
}

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  let code: number = Exit.ok
  const program = buildProgram(io, (c) => {
    code = c
  })
  try {
    await program.parseAsync(argv)
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit through here with code 0.
      return err.exitCode === 0 ? Exit.ok : Exit.invalidInput
    }
    io.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
    // A command that ended this way is Tade's own trouble: said here, and
    // sent to whoever is watching Tade itself, when anybody is.
    await reportCrash(err, argv)
    return Exit.error
  }
  return code
}
