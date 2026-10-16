import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { createInterface } from 'node:readline'
import {
  caddySite,
  defaultConfigPath,
  lingerCommand,
  loadConfig,
  PUBLIC_DIR,
  publicName,
  publicSocket,
  tadeHome,
} from '@tade/core'
import { answering, dirSeen } from '@tade/web'
import { lookAtCertificate } from '@tade/workbench/certificate'
import { systemdHere, unattendedHere } from '@tade/workbench/machine'
import { lastUpdates } from '@tade/workbench/programs'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { caddySaid, lookAtPublic } from './host-caddy.ts'
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
    .command('caddy [name]')
    .description(
      'Print the Caddy site block that puts the away view on a public name, and what else it needs',
    )
    .option('--check', 'look from here: the directory, the socket, the certificate, the version')
    .action(async (given: string | undefined, opts: { check?: boolean }) => {
      const loaded = await loadConfig(defaultConfigPath())
      const configured = loaded.ok ? loaded.config.surfaces.web.public : ''
      const name = (given ?? configured).toLowerCase()
      if (name === '' || !publicName(name)) {
        io.err(
          name === ''
            ? 'No public name: `tade host caddy tade.example.com`, or set surfaces.web.public (Settings › Away view › Public name).'
            : `${name} is not a host name: no scheme, port, path or address — tade.example.com`,
        )
        setExit(Exit.invalidInput)
        return
      }
      const socket = publicSocket()
      const dir = await dirSeen(PUBLIC_DIR)
      const uid = process.getuid?.() ?? -1
      io.out(caddySite(name, socket).trimEnd())
      for (const line of caddySaid({
        name,
        configured,
        user: userInfo().username,
        socket,
        dir,
        uid,
      }))
        io.err(line)
      if (!opts.check) return
      const looked = await lookAtPublic({
        name,
        socket,
        uid,
        dir,
        answering,
        look: (one) => lookAtCertificate(one),
        newer: async () => {
          const kept = await lastUpdates(tadeHome())
          return kept === null ? null : { newer: kept.tade.newer }
        },
        now: Date.now(),
      })
      io.err('')
      for (const one of looked) io.err(`${one.loud ? '▲' : '·'} ${one.said}`)
      if (looked.some((one) => one.loud)) setExit(Exit.error)
    })
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
