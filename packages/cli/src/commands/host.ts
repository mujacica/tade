import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  caddySite,
  copiedHosts,
  defaultConfigPath,
  domainSays,
  lingerCommand,
  loadConfig,
  PUBLIC_DIR,
  publicSocket,
  tadeHome,
} from '@tade/core'
import { answering, dirSeen } from '@tade/web'
import { lookAtCertificate } from '@tade/workbench/certificate'
import { accountUri, lookAtDomain } from '@tade/workbench/domain'
import { readJournal } from '@tade/workbench/events'
import { heldBy } from '@tade/workbench/lock'
import { systemdHere, unattendedHere } from '@tade/workbench/machine'
import { lastUpdates } from '@tade/workbench/programs'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import {
  type BackupDeps,
  initBackup,
  listBackups,
  offerTimer,
  resticHere,
  restoreBackup,
  takeBackup,
  timerHere,
} from './host-backup.ts'
import { caddySaid, lookAtPublic } from './host-caddy.ts'
import { domainJson, domainPrinted, domainRefused, offerName } from './host-domain.ts'
import {
  type Asker,
  lanesWouldStop,
  offerUnit,
  serviceLacksGroups,
  unitHere,
} from './host-service.ts'

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
      const refused = name === '' ? null : domainRefused(name)
      if (name === '' || refused !== null) {
        io.err(
          refused ??
            'No public name: `tade host caddy tade.example.com`, or set surfaces.web.public (Settings › Away view › Public name).',
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
    .command('domain <name>')
    .description(
      'Look at the records a public name needs, from here — A, AAAA, DNSSEC, CAA — say what to add for each, and set the name on a press',
    )
    .option(
      '--account <uri>',
      "Caddy's account at Let's Encrypt, for the CAA record, where it cannot be read here",
    )
    .option('--write', 'write it as the public name without asking')
    .option('--json', 'machine-readable output')
    .action(async (given: string, opts: { account?: string; write?: boolean; json?: boolean }) => {
      const name = given.toLowerCase().replace(/\.$/, '')
      const refused = domainRefused(name)
      if (refused !== null) {
        io.err(refused)
        setExit(Exit.invalidInput)
        return
      }
      const account = opts.account
      if (account !== undefined && !accountUri(account)) {
        io.err(
          `${account} is not an account: an https URL, the way Caddy keeps it — https://acme-v02.api.letsencrypt.org/acme/acct/…`,
        )
        setExit(Exit.invalidInput)
        return
      }
      const seen = await lookAtDomain(
        name,
        account === undefined ? {} : { account: async () => ({ uri: account }) },
      )
      const loud = domainSays(seen).some((one) => one.loud)
      if (opts.json) io.out(JSON.stringify(domainJson(seen), null, 2))
      else for (const line of domainPrinted(seen)) io.out(line)
      if (loud) setExit(Exit.error)
      if (opts.json && !opts.write) return
      // The name goes into the config on a press and never otherwise
      // (`offerName`): it decides who reaches this machine.
      const home = tadeHome()
      const written = await offerName(terminal(io), name, {
        path: defaultConfigPath(),
        loud,
        write: opts.write === true,
        asking: process.stdin.isTTY === true && process.stderr.isTTY === true,
        copies: async () => copiedHosts(await readJournal(home, { types: ['config_changed'] })),
        open: async () => (await heldBy(home)) !== null,
      })
      if (!written) setExit(Exit.error)
    })
  host
    .command('service')
    .description(
      'Print the systemd user unit that keeps Tade running on a Linux server, and write it on a press',
    )
    .option('--write', 'write it, and say how to start it, without asking')
    .action(async (opts: { write?: boolean }) => {
      const unit = unitHere()
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
      for (const lacking of await serviceLacksGroups()) ask.say(lacking)
      if (box && !box.linger) {
        ask.say(`linger is off, so it stops when you log out: \`${lingerCommand(box)}\``)
      }
      if (!opts.write && !(process.stdin.isTTY && process.stderr.isTTY)) {
        ask.say(`\`tade host service --write\` writes it to ${unit.path}`)
        return
      }
      await offerUnit(ask, unit, { write: opts.write === true, start: true })
    })

  // Backups (`host-backup.ts`): the home and the harnesses' conversations,
  // encrypted by restic, to a repository the person names — and back.
  const backupDeps = async (json: boolean, from?: string): Promise<BackupDeps | null> => {
    const path = defaultConfigPath()
    const loaded = await loadConfig(path)
    if (!loaded.ok) {
      io.err(`${loaded.path}: invalid config (run \`tade config --check\`)`)
      setExit(Exit.invalidInput)
      return null
    }
    const asking = !json && process.stdin.isTTY === true && process.stderr.isTTY === true
    const config =
      from === undefined
        ? loaded.config
        : { ...loaded.config, backup: { ...loaded.config.backup, repository: from } }
    return {
      ask: terminal(io),
      asking,
      place: { config, home: tadeHome(), restic: resticHere(), asks: asking },
      configPath: path,
      out: io.out,
      held: () => heldBy(tadeHome()),
      unrecorded: (said) => io.err(said),
    }
  }
  host
    .command('backup')
    .description(
      'Back this machine’s Tade up with restic, encrypted, to a repository you name: its home and the harnesses’ conversations — never the index or the worktrees',
    )
    .option(
      '--init <repository>',
      'name where backups go — a folder, sftp:user@host:/path, s3:… — make its password, and make it there',
    )
    .option('--list', 'the backups there, newest first')
    .option('--timer', 'print the systemd timer that backs up every hour, and write it on a press')
    .option('--write', 'with --timer: write it, and say how to start it, without asking')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: {
        init?: string
        list?: boolean
        timer?: boolean
        write?: boolean
        json?: boolean
      }) => {
        const json = opts.json === true
        const deps = await backupDeps(json)
        if (deps === null) return
        if (opts.init !== undefined) setExit(await initBackup(deps, opts.init))
        else if (opts.list) setExit(await listBackups(deps, json))
        else if (opts.timer) {
          const bin = fileURLToPath(new URL('../bin.ts', import.meta.url))
          const write = opts.write === true
          setExit(
            await offerTimer(deps, timerHere(process.env, bin), { write, systemd: systemdHere() }),
          )
        } else setExit(await takeBackup(deps, json))
      },
    )
  host
    .command('restore [snapshot]')
    .description(
      'Put a backup back as this machine’s Tade — the latest, unless you name one — or, with --to, under a folder to look at',
    )
    .option(
      '--from <repository>',
      'where to restore from, on a machine whose config does not say yet',
    )
    .option('--to <folder>', 'restore under this folder as it was laid out, and move nothing')
    .option('--yes', 'restore into the home without asking')
    .action(
      async (snapshot: string | undefined, opts: { from?: string; to?: string; yes?: boolean }) => {
        const deps = await backupDeps(false, opts.from)
        if (deps === null) return
        setExit(
          await restoreBackup(deps, snapshot ?? 'latest', {
            ...(opts.to === undefined ? {} : { to: opts.to }),
            yes: opts.yes === true,
          }),
        )
      },
    )
}
