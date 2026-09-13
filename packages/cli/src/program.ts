import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { collectStatus } from '@wilco/status'
// Subpath imports: the CLI must not load the driver stack just to read status.
import { laneLivenessFromFile } from '@wilco/workbench/lane-liveness'
import { Command, CommanderError } from 'commander'
import { registerApp } from './commands/app.ts'
import { registerBrief } from './commands/brief.ts'
import { registerChat } from './commands/chat.ts'
import { registerCheck } from './commands/check.ts'
import { registerLanes } from './commands/lanes.ts'
import { registerNotes } from './commands/notes.ts'
import { registerExtensions, registerSkills } from './commands/proposals.ts'
import { registerSetup } from './commands/setup.ts'
import { registerSpend } from './commands/spend.ts'
import { registerSummary } from './commands/summary.ts'
import { registerTasks } from './commands/tasks.ts'
import { registerVoice } from './commands/voice.ts'
import { formatStatus } from './format.ts'
import { defaultIo, Exit, type Io } from './io.ts'

export { Exit, type Io } from './io.ts'

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return pkg.version
}

export function buildProgram(io: Io, setExit: (code: number) => void): Command {
  const program = new Command('wilco')
    .description('A voice-first workbench for running coding agents on your own machine.')
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
    .command('config')
    .description('Inspect ~/.wilco/config.yaml')
    .option('--check', 'validate the config file and exit')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { check?: boolean; config: string }) => {
      const result = await loadConfig(opts.config)
      if (!result.ok) {
        io.err(`${result.path}: invalid config`)
        for (const issue of result.issues) {
          io.err(`  ${issue.path || '(file)'}: ${issue.message}`)
        }
        setExit(Exit.invalidInput)
        return
      }
      if (opts.check) {
        io.out(result.exists ? `${result.path}: ok` : `${result.path}: not found, using defaults`)
        return
      }
      io.out(JSON.stringify(result.config, null, 2))
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
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      // Read the lanes rather than take the workbench: status is a question,
      // and asking it must never wait on, or interfere with, an open window.
      const liveness = await laneLivenessFromFile(wilcoHome())
      const ws = await collectStatus({
        config: cfg.config,
        now: Date.now(),
        home: homedir(),
        cwd: process.cwd(),
        pr: opts.pr && process.env.WILCO_NO_GH !== '1',
        liveness,
      })
      if (opts.json) io.out(JSON.stringify(ws, null, 2))
      else for (const line of formatStatus(ws)) io.out(line)
    })

  registerSetup(program, io, setExit)
  registerApp(program, io, setExit)
  registerBrief(program, io, setExit)
  registerChat(program, io, setExit)
  registerCheck(program, io, setExit)
  registerTasks(program, io, setExit)
  registerLanes(program, io, setExit)
  registerNotes(program, io, setExit)
  registerSpend(program, io, setExit)
  registerSummary(program, io, setExit)
  registerVoice(program, io, setExit)
  registerExtensions(program, io, setExit)
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
    return Exit.error
  }
  return code
}
