import { Command, CommanderError } from 'commander'
import { defaultIo, Exit, type Io } from './io.ts'
import { unsayOpening } from './opening.ts'
import { version } from './version.ts'

export { Exit, type Io } from './io.ts'

/** What adds one command, or a few that share a module, to the program. */
type Register = (program: Command, io: Io, setExit: (code: number) => void) => void

/**
 * Every command, in the order `--help` lists them, by every name it is typed
 * as, and how to load it.
 *
 * Loaded when it is the one typed, never all of them for one. Each module
 * brings its own dependencies, and loading all twenty-six to run one was every
 * command paying for every other: `tade status` loaded the window, the
 * orchestrator and the driver stack to read a few files. A name missing here
 * is not a command that stops working — anything not listed loads everything,
 * which is what every command did before — and `test/commands.test.ts` holds
 * the names to what each module registers.
 */
export const COMMANDS: readonly { names: readonly string[]; load: () => Promise<Register> }[] = [
  { names: ['status'], load: async () => (await import('./commands/status.ts')).registerStatus },
  { names: ['config'], load: async () => (await import('./commands/config.ts')).registerConfig },
  { names: ['setup'], load: async () => (await import('./commands/setup.ts')).registerSetup },
  { names: ['app'], load: async () => (await import('./commands/app.ts')).registerApp },
  { names: ['brief'], load: async () => (await import('./commands/brief.ts')).registerBrief },
  { names: ['chat'], load: async () => (await import('./commands/chat.ts')).registerChat },
  { names: ['check'], load: async () => (await import('./commands/check.ts')).registerCheck },
  {
    names: ['accounts'],
    load: async () => (await import('./commands/accounts.ts')).registerAccounts,
  },
  { names: ['checks'], load: async () => (await import('./commands/checks.ts')).registerChecks },
  {
    names: ['task', 'run', 'approvals', 'approve', 'deny'],
    load: async () => (await import('./commands/tasks.ts')).registerTasks,
  },
  {
    names: ['spawn', 'lanes', 'kill', 'attach', 'logs'],
    load: async () => (await import('./commands/lanes.ts')).registerLanes,
  },
  { names: ['intake'], load: async () => (await import('./commands/intake.ts')).registerIntake },
  {
    names: ['remember', 'notes'],
    load: async () => (await import('./commands/notes.ts')).registerNotes,
  },
  {
    names: ['documents'],
    load: async () => (await import('./commands/documents.ts')).registerDocuments,
  },
  { names: ['spend'], load: async () => (await import('./commands/spend.ts')).registerSpend },
  { names: ['stats'], load: async () => (await import('./commands/stats.ts')).registerStats },
  { names: ['eval'], load: async () => (await import('./commands/eval.ts')).registerEval },
  { names: ['queue'], load: async () => (await import('./commands/queue.ts')).registerQueue },
  {
    names: ['schedules'],
    load: async () => (await import('./commands/schedules.ts')).registerSchedules,
  },
  { names: ['summary'], load: async () => (await import('./commands/summary.ts')).registerSummary },
  { names: ['voice'], load: async () => (await import('./commands/voice.ts')).registerVoice },
  { names: ['web'], load: async () => (await import('./commands/web.ts')).registerWeb },
  { names: ['update'], load: async () => (await import('./commands/update.ts')).registerUpdate },
  { names: ['host'], load: async () => (await import('./commands/host.ts')).registerHost },
  {
    names: ['extensions'],
    load: async () => (await import('./commands/proposals.ts')).registerExtensions,
  },
  { names: ['mcp'], load: async () => (await import('./commands/mcp.ts')).registerMcp },
  {
    names: ['skills'],
    load: async () => (await import('./commands/proposals.ts')).registerSkills,
  },
  {
    names: ['templates'],
    load: async () => (await import('./commands/templates.ts')).registerTemplates,
  },
  {
    names: ['personas'],
    load: async () => (await import('./commands/templates.ts')).registerPersonas,
  },
]

/** The flags that list every command, which only every command can answer. */
const LISTING = new Set(['-h', '--help'])

/**
 * The commands these arguments need: the one typed, the window where none
 * is, and all of them for help, `help`, or a name that is not one of them —
 * so commander can say so in its own words, as it always has. The root takes
 * no option with a value, so the first word that is not a flag is the command.
 */
export function commandsFor(args: readonly string[]): typeof COMMANDS {
  if (args.some((arg) => LISTING.has(arg))) return COMMANDS
  const typed = args.find((arg) => !arg.startsWith('-')) ?? 'app'
  const found = COMMANDS.find((command) => command.names.includes(typed))
  return found ? [found] : COMMANDS
}

export async function buildProgram(
  io: Io,
  setExit: (code: number) => void,
  args: readonly string[] = [],
): Promise<Command> {
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
  const wanted = commandsFor(args)
  // Loaded side by side, registered in the order help lists them.
  const registers = await Promise.all(wanted.map((command) => command.load()))
  for (const register of registers) register(program, io, setExit)
  return program
}

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  let code: number = Exit.ok
  const program = await buildProgram(
    io,
    (c) => {
      code = c
    },
    argv.slice(2),
  )
  try {
    await program.parseAsync(argv)
  } catch (err) {
    unsayOpening()
    if (err instanceof CommanderError) {
      // --help / --version exit through here with code 0.
      return err.exitCode === 0 ? Exit.ok : Exit.invalidInput
    }
    io.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
    // A command that ended this way is Tade's own trouble: said here, and
    // sent to whoever is watching Tade itself, when anybody is. Loaded on this
    // path only: a command that worked never opens it.
    const { reportCrash } = await import('./telemetry.ts')
    await reportCrash(err, argv)
    return Exit.error
  }
  return code
}
