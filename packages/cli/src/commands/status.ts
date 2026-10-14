import { homedir } from 'node:os'
import { defaultConfigPath, loadConfig, tadeHome } from '@tade/core'
import { collectStatus } from '@tade/status'
// Subpath imports: the CLI must not load the driver stack just to read status.
import { laneLivenessFromFile } from '@tade/workbench/lane-liveness'
import type { Command } from 'commander'
import { formatStatus } from '../format.ts'
import { Exit, type Io } from '../io.ts'

export function registerStatus(program: Command, io: Io, setExit: (code: number) => void): void {
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
        // Once, so worth the two spawns: which port each lane's server is on.
        ports: true,
        liveness,
      })
      if (opts.json) io.out(JSON.stringify(ws, null, 2))
      else for (const line of formatStatus(ws)) io.out(line)
    })
}
