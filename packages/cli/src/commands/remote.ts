import { defaultConfigPath, loadConfig, type RemoteConfig, tadeHome } from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import { heldBy } from '@tade/workbench/lock'
import { type LinkSeen, linkOf, linksSeen, REMOTE_LINKS, remoteOf } from '@tade/workbench/remotes'
import type { Command } from 'commander'
import { writeFromShell } from '../config-write.ts'
import { Exit, type Io } from '../io.ts'
import {
  type AddOpts,
  addRemote,
  carryRemote,
  listed,
  type Place,
  ttyAsking,
} from './remote-guide.ts'

// `tade remote` — the other machines' Tades this one is an owner of
// (REMOTE-TADE.md §4.4, §13 V6).
//
// **`add` is the one way a remote gets into the config**: it runs `tade web
// pair --owner` there over SSH, and writes what that printed — the session, a
// credential — into `remotes.<name>`, which is the `never` tier: nothing the
// orchestrator or an agent's tool says can point this machine at another one.
// An agent can still run this command, as it can run `ssh`; that is the
// sentence the remote prints (`OWNER_IS_YOUR_SSH_KEY`) and the one beside it
// here (`REMOTE_KEPT_HERE`).
//
// **And it is the guided way a remote is set up** (`remote-guide.ts`): a
// machine never met is shown and trusted on a press before anything is sent,
// this machine's preferences, personas and published templates are carried
// there, its keys are offered on a press with what that means said first, each
// harness this machine uses is signed in there through its own sign-in in this
// terminal, and it ends with a checklist of what was done and what is left.
// `carry` does the same again later, for a remote added with nobody to ask.
//
// **`list` and `status` read files only** — the config, and the journal's
// `remote_linked`/`remote_unlinked` lines — so they answer with the window open
// or closed, and never open the workbench. The links themselves live in the
// window, which is the one thing holding them; a window open on this home
// picks up a remote added here within a beat (`wire/remotes.ts`).
//
// **`remove` signs this machine out there first**, and takes the remote out of
// the config whatever came of that, saying how to finish by hand where the
// remote could not be reached: a session left behind there is one nobody here
// can use any more, but it is still a line in that machine's device list.

export function registerRemote(program: Command, io: Io, setExit: (code: number) => void): void {
  const remote = program
    .command('remote')
    .description(
      'Other machines’ Tades this one drives over SSH: add one, see how each is linked, remove one',
    )

  remote
    .command('add <name>')
    .description(
      'Pair with the Tade on another machine over SSH, as an owner of it, and link to it',
    )
    .requiredOption(
      '--ssh <destination>',
      'where ssh reaches it: a Host from ~/.ssh/config, user@host, or ssh://user@host:port',
    )
    .option(
      '--tade <command>',
      'the tade to run there, where it is not on the PATH a command over SSH gets',
      'tade',
    )
    .option('--label <name>', 'what this machine is called in that one’s device list')
    .option(
      '--accept-key <fingerprint>',
      'trust a machine never met, for exactly this host key fingerprint (repeat for each)',
      (one: string, all: string[] = []) => [...all, one],
    )
    .option('--json', 'machine-readable output (never the session)')
    .action(async (name: string, opts: AddOpts) => {
      await addRemote(shellPlace(io, setExit, opts.json === true), name, opts)
    })

  remote
    .command('list')
    .description('Every remote, where it is and which device this machine is there')
    .option('--json', 'machine-readable output (never the session)')
    .action(async (opts: { json?: boolean }) => {
      const remotes = await configured(io, setExit)
      if (remotes === null) return
      const rows = Object.entries(remotes).map(([name, one]) => listed(name, one))
      if (opts.json) {
        io.out(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0)
        io.out('no remotes: `tade remote add <name> --ssh <host>` pairs with one')
      for (const row of rows)
        io.out(`${row.name}  ssh ${row.ssh}  device ${row.device}  ${row.host}`)
    })

  remote
    .command('status [name]')
    .description(
      'How each remote’s link last stood, out of the journal, and whether a window holds the links now',
    )
    .option('--json', 'machine-readable output')
    .action(async (only: string | undefined, opts: { json?: boolean }) => {
      const remotes = await configured(io, setExit)
      if (remotes === null) return
      if (only !== undefined && remotes[only] === undefined) {
        io.err(`there is no remote called ${only}`)
        setExit(Exit.invalidInput)
        return
      }
      const home = tadeHome()
      const window = (await heldBy(home)) !== null
      const seen = linksSeen(
        await readJournal(home, { types: ['remote_linked', 'remote_unlinked'] }),
      )
      const rows = Object.entries(remotes)
        .filter(([name]) => only === undefined || name === only)
        .map(([name, one]) => ({ ...listed(name, one), link: seen.get(name) ?? null }))
      if (opts.json) {
        io.out(JSON.stringify({ window, remotes: rows }, null, 2))
        return
      }
      if (rows.length === 0)
        io.out('no remotes: `tade remote add <name> --ssh <host>` pairs with one')
      for (const row of rows) io.out(`${row.name}  ${stood(row.link)}  (ssh ${row.ssh})`)
      if (rows.length > 0 && !window) {
        io.out(
          'no window is open on this home, so nothing is linked now: the window holds the links',
        )
      }
    })

  remote
    .command('carry <name>')
    .description(
      'Carry this machine’s preferences, personas and templates to a remote again, and say what is left',
    )
    .option('--keys', 'send the keys too, which waits on your press unless --yes')
    .option(
      '--talk',
      'turn on talking to Tade from here on that machine, which waits on your press unless --yes',
    )
    .option('--yes', 'the press, given ahead: send the keys, or turn talking on, without asking')
    .option(
      '--ours <path>',
      'send this machine’s value over one that machine changed itself (repeat for each)',
      (one: string, all: string[] = []) => [...all, one],
    )
    .option('--json', 'machine-readable output')
    .action(
      async (
        name: string,
        opts: { keys?: boolean; talk?: boolean; yes?: boolean; ours?: string[]; json?: boolean },
      ) => {
        await carryRemote(shellPlace(io, setExit, opts.json === true), name, opts)
      },
    )

  remote
    .command('remove <name>')
    .description('Sign this machine out of a remote, and forget it here')
    .action(async (name: string) => {
      await removeOne(io, setExit, name)
    })
}

/** How a link last stood, in the words a terminal gets. */
function stood(link: LinkSeen | null): string {
  if (link === null) return 'not linked yet'
  const at = link.at.slice(0, 16).replace('T', ' ')
  if (link.word === 'up') return `up since ${at}`
  if (link.word === 'ended') return `signed out there at ${at}: ${link.said}`
  return `down since ${at}${link.said === '' ? '' : `: ${link.said}`}`
}

/** The remotes in the config, or null having said why there are none to read. */
async function configured(
  io: Io,
  setExit: (code: number) => void,
): Promise<Readonly<Record<string, RemoteConfig>> | null> {
  const path = defaultConfigPath()
  const loaded = await loadConfig(path)
  if (!loaded.ok) {
    io.err(`${path} could not be read: \`tade config --check\` says what is wrong with it`)
    setExit(Exit.error)
    return null
  }
  return loaded.config.remotes
}

/** The terminal's own place: this home, the registered links, and asking at this terminal. */
function shellPlace(io: Io, setExit: (code: number) => void, json: boolean): Place {
  const home = tadeHome()
  return {
    io,
    setExit,
    home,
    configPath: defaultConfigPath(),
    linkFor: (kind) => REMOTE_LINKS[kind]?.({ home }),
    asking: ttyAsking(json),
    now: Date.now,
  }
}

async function removeOne(io: Io, setExit: (code: number) => void, name: string): Promise<void> {
  const remotes = await configured(io, setExit)
  if (remotes === null) return
  const one = remotes[name]
  if (one === undefined) {
    io.err(`there is no remote called ${name}`)
    setExit(Exit.invalidInput)
    return
  }
  const link = REMOTE_LINKS[linkOf(one)]?.({ home: tadeHome() })
  let signedOut = false
  let why = 'there is no link here that reaches it'
  if (link !== undefined) {
    try {
      await link.unpair(remoteOf(name, one))
      signedOut = true
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
  }
  await writeFromShell(defaultConfigPath(), [{ key: `remotes.${name}`, value: undefined }], io.err)
  io.out(`${name}: forgotten here`)
  if (signedOut) io.out(`and signed out there: ${one.ssh} no longer knows device ${one.device}`)
  else {
    io.err(
      `it could not be signed out there (${why}), so its device is still in that machine’s list:`,
    )
    io.err(`run \`ssh ${one.ssh} ${one.tade} web revoke ${one.device}\` once it answers`)
  }
}
