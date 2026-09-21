import { defaultConfigPath, loadConfig, tadeHome } from '@tade/core'
import { lookAtUpdates, type ProgramLook, type UpdateLook } from '@tade/workbench/programs'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// What Tade runs, and whether it is current.
//
// The same reading the Updates page shows, for a shell — so the question can
// be asked with a window open, which is the rule for every question Tade
// answers. It never installs anything: what comes back is the exact command,
// for a person to run or not.
//
// Asking what is current reaches the network, and does so only when `--check`
// says to. Without it this says what is installed here and nothing else.

function line(look: ProgramLook, asked: boolean): string {
  // Before anything has been asked, what is current is not unknown — it is
  // unasked, which the foot of the answer says once rather than every line.
  const mark = !look.install
    ? look.need.optional
      ? 'not installed, and optional'
      : 'not installed'
    : !asked
      ? ''
      : look.behind && look.latest
        ? `${look.latest} is out`
        : look.latest
          ? 'current'
          : 'cannot tell'
  const said = look.install ? look.install.said : (look.need.needed[0]?.what ?? '')
  return `${look.need.command.padEnd(10)} ${(look.version ?? '—').padEnd(12)} ${mark.padEnd(30)} ${said}`
}

function saidAbout(look: UpdateLook): string[] {
  const out: string[] = []
  const tade = look.tade
  const where =
    tade.from === 'checkout'
      ? `a git checkout at ${tade.where}`
      : (tade.install?.said ?? tade.where)
  const about = tade.newer ?? (!look.asked ? '' : tade.cannotTell ? 'cannot tell' : 'current')
  out.push(`tade       ${tade.version.padEnd(12)} ${about.padEnd(30)} ${where}`)
  if ('command' in tade.update) out.push(`           ${tade.update.command}`)
  out.push('')
  for (const program of look.programs) {
    out.push(line(program, look.asked))
    if ('command' in program.update) out.push(`           ${program.update.command}`)
    if (!program.need.inUse) out.push('           nothing Tade is set up to use needs it')
  }
  if (!look.asked) {
    out.push('')
    out.push('Nothing was asked of the network: run with --check for what is current.')
  }
  return out
}

export function registerUpdate(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('update')
    .description(
      'The programs Tade runs and Tade itself: what is here, how it got here, and what to run to ' +
        'move it forward. Changes nothing.',
    )
    .option('--check', 'also ask what is current (this reaches the network)')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { check?: boolean; json?: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      const look = await lookAtUpdates(cfg.config, tadeHome(), { ask: opts.check === true })
      if (opts.json) {
        io.out(JSON.stringify(look, null, 2))
        return
      }
      for (const said of saidAbout(look)) io.out(said)
    })
}
