import { hostname } from 'node:os'
import {
  defaultConfigPath,
  loadConfig,
  OWNER_IS_YOUR_SSH_KEY,
  REMOTE_KEPT_HERE,
  RemoteCommand,
  type RemoteConfig,
  RemoteName,
  SshDestination,
  tadeHome,
  writeSetting,
} from '@tade/core'
import { LinkError } from '@tade/remotes-core'
import { readJournal } from '@tade/workbench/events'
import { heldBy } from '@tade/workbench/lock'
import { type LinkSeen, linkOf, linksSeen, REMOTE_LINKS, remoteOf } from '@tade/workbench/remotes'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

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
    .option('--json', 'machine-readable output (never the session)')
    .action(
      async (name: string, opts: { ssh: string; tade: string; label?: string; json?: boolean }) => {
        await add(io, setExit, name, opts)
      },
    )

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
    .command('remove <name>')
    .description('Sign this machine out of a remote, and forget it here')
    .action(async (name: string) => {
      await removeOne(io, setExit, name)
    })
}

/** What a remote is, said without its session. */
function listed(name: string, one: RemoteConfig) {
  return { name, ssh: one.ssh, tade: one.tade, device: one.device, host: one.host }
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

/**
 * This machine, as the other one's device list calls it: its host name, cut to
 * what a label may be and to characters a remote shell has no opinion about.
 */
function labelHere(name: string = hostname()): string {
  const plain = name.replace(/\.local$/, '').replace(/[^A-Za-z0-9._-]+/g, '-')
  return (plain === '' ? 'this machine' : plain).slice(0, 60)
}

async function add(
  io: Io,
  setExit: (code: number) => void,
  name: string,
  opts: { ssh: string; tade: string; label?: string; json?: boolean },
): Promise<void> {
  // Each refused for its shape before anything runs: the destination becomes
  // an argument to ssh and the command a word a remote shell reads.
  for (const [what, schema, value] of [
    ['a remote’s name', RemoteName, name],
    ['--ssh', SshDestination, opts.ssh],
    ['--tade', RemoteCommand, opts.tade],
  ] as const) {
    const checked = schema.safeParse(value)
    if (!checked.success) {
      io.err(`${what}: ${checked.error.issues[0]?.message ?? 'not one'}`)
      setExit(Exit.invalidInput)
      return
    }
  }
  const remotes = await configured(io, setExit)
  if (remotes === null) return
  if (remotes[name] !== undefined) {
    io.err(`there is already a remote called ${name}: \`tade remote remove ${name}\` first`)
    setExit(Exit.invalidInput)
    return
  }
  const home = tadeHome()
  const link = REMOTE_LINKS[linkOf({ ssh: opts.ssh } as RemoteConfig)]?.({ home })
  if (link === undefined) {
    io.err('there is no link here that reaches a remote over SSH')
    setExit(Exit.error)
    return
  }
  let session: Awaited<ReturnType<typeof link.pair>>
  try {
    session = await link.pair({
      address: opts.ssh,
      tade: opts.tade,
      label: opts.label ?? labelHere(),
    })
  } catch (err) {
    io.err(
      `could not pair with ${opts.ssh}: ${err instanceof LinkError ? err.message : String(err)}`,
    )
    setExit(Exit.error)
    return
  }
  const written: RemoteConfig = {
    ssh: opts.ssh,
    tade: opts.tade,
    device: session.device,
    session: session.cookie,
    csrf: session.csrf,
    host: session.host,
  }
  const path = defaultConfigPath()
  writeSetting(path, `remotes.${name}`, {
    ...written,
    ...(opts.tade === 'tade' ? { tade: undefined } : {}),
  })
  const loaded = await loadConfig(path)
  if (!loaded.ok || loaded.config.remotes[name] === undefined) {
    // What the remote printed would not load as a remote here: it is taken
    // back out, and the session there signed out, rather than left half-made.
    writeSetting(path, `remotes.${name}`, undefined)
    await link.unpair(remoteOf(name, written)).catch((err: unknown) => {
      io.err(
        `and it could not be signed out there (${err instanceof Error ? err.message : String(err)}):`,
      )
      io.err(`run \`ssh ${opts.ssh} ${opts.tade} web revoke ${session.device}\` once it answers`)
    })
    io.err(
      `${opts.ssh} printed a session this Tade cannot keep: ${loaded.ok ? 'it was not written' : (loaded.issues[0]?.message ?? '')}`,
    )
    setExit(Exit.error)
    return
  }
  const window = (await heldBy(home)) !== null
  if (opts.json) {
    io.out(JSON.stringify({ ...listed(name, written), window }, null, 2))
  } else {
    io.out(
      `${name}: this machine is an owner of the Tade at ${opts.ssh}, as device ${session.device}`,
    )
    io.out(
      window
        ? 'the window open on this home links it within a few seconds: `tade remote status` says how it stands'
        : 'it is linked while a window is open on this home: `tade app`, then `tade remote status`',
    )
  }
  io.err(REMOTE_KEPT_HERE)
  io.err(OWNER_IS_YOUR_SSH_KEY)
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
  writeSetting(defaultConfigPath(), `remotes.${name}`, undefined)
  io.out(`${name}: forgotten here`)
  if (signedOut) io.out(`and signed out there: ${one.ssh} no longer knows device ${one.device}`)
  else {
    io.err(
      `it could not be signed out there (${why}), so its device is still in that machine’s list:`,
    )
    io.err(`run \`ssh ${one.ssh} ${one.tade} web revoke ${one.device}\` once it answers`)
  }
}
