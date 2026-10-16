import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { lingerCommand } from '@tade/core'
import { systemdHere, unattendedHere } from '@tade/workbench/machine'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { type Asker, lanesWouldStop, offerUnit, unitHere } from './host-service.ts'

// `tade host`: Tade on a server of its own. The command and the terminal it
// asks in; what it builds, writes and offers is `host-service.ts`, which
// `tade setup` asks through too.

/** Asking in this terminal: the question on standard error, so the unit alone is on standard output. */
function terminal(io: Io): Asker {
  return {
    say: (text) => io.err(text),
    async confirm(question, fallback) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        rl.setPrompt(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)
        rl.prompt()
        // Iterated rather than asked: `question()` never settles at end of input.
        for await (const line of rl) {
          const said = line.trim().toLowerCase()
          return said === '' ? fallback : said.startsWith('y')
        }
        return false
      } finally {
        rl.close()
      }
    },
    run: (_title, command, args) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { stdio: 'inherit' })
        child.on('exit', (code) => resolve(code ?? Exit.error))
        child.on('error', () => resolve(Exit.error))
      }),
  }
}

export function registerHost(program: Command, io: Io, setExit: (code: number) => void): void {
  const host = program
    .command('host')
    .description('Tade on a server of its own: what keeps it running there')
  host
    .command('service')
    .description(
      'Print the systemd user unit that keeps Tade running on a Linux server, and write it on a press',
    )
    .option('--write', 'write it, and say how to start it, without asking')
    .action(async (opts: { write?: boolean }) => {
      const unit = await unitHere()
      if ('cannot' in unit) {
        io.err(unit.cannot)
        setExit(Exit.error)
        return
      }
      io.out(unit.text.trimEnd())
      const box = unattendedHere()
      if (!systemdHere()) {
        // Printing it is still worth something — to read, or to copy to the
        // box it is for — but writing it here would run nothing.
        io.err('')
        io.err('systemd does not run this machine, so nothing here would start it: it is for a')
        io.err('Linux server. On one, `tade host service` writes it.')
        if (opts.write) setExit(Exit.error)
        return
      }
      const ask = terminal(io)
      ask.say('')
      const stops = await lanesWouldStop()
      if (stops) ask.say(stops)
      if (box && !box.linger) {
        ask.say(`linger is off, so it stops when you log out: \`${lingerCommand(box)}\``)
      }
      if (!opts.write && !(process.stdin.isTTY && process.stderr.isTTY)) {
        ask.say(`\`tade host service --write\` writes it to ${unit.path}`)
        return
      }
      await offerUnit(ask, unit, { write: opts.write === true, start: true })
    })
}
