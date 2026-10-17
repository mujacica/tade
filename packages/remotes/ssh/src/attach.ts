import type { RequiredProgram } from '@tade/core'
import type { TerminalThere } from '@tade/remotes-core'

// A terminal here that is one of another machine's agents, typed into: the
// line that machine gave for the agent's lane (`/api/attach`), run there
// (REMOTE-TADE.md §3.4).
//
// **Over mosh where both machines have it**, and `ssh -t` everywhere else.
// mosh shows what is typed before the far end answers and keeps the session
// through a sleep and a change of network (§3.3), and both are what a terminal
// to a machine 150 ms away needs; but it needs its server at the far end and
// UDP 60000–61000 open there, which a firewall set up by the book closes. So
// it is used only where this machine has `mosh` and the remote answers
// `command -v mosh-server` — asked over the window's master, now and then.
//
// **And only where it gets through.** With the UDP closed mosh never ends: it
// sits on its own banner — `Nothing received from server on UDP port 60001.`,
// a quarter of a second in — for fifteen seconds before it gives up (mosh
// 1.4's `stmclient.cc`). So a mosh terminal is handed back with `proving`:
// the window gives it `MOSH_WITHIN_MS`, reads that banner off its screen, and
// one that is still on it, or ended, did not get through. That is remembered
// per remote (`attached`) and every terminal to it goes over ssh until a later
// try of mosh works — one an hour after it last did not (`MOSH_AGAIN_MS`).
//
// **A lost connection is ssh's 255** (`lost`): its own exit, never the remote
// command's, so a terminal that ended by it ended because the connection did,
// and the window runs it again when the link comes back. mosh says nothing of
// the kind because it never loses one: it outlives a sleep and a new network.
//
// **Over the window's master** in both cases (`-S`), so a terminal is a
// session on the connection already up: one or two round trips, not nine.
// Not `BatchMode`: a person is at this one, and a passphrase it asks for is
// theirs to type. `ServerAliveInterval` ends a terminal whose connection died
// in ten seconds, rather than leaving a pane that looks alive.

/** What mosh needs let through on the far machine, as a firewall names it. */
export const MOSH_PORTS = 'UDP 60000–61000'

/**
 * Opening those ports for mosh, as an optional step: said by `tade remote add`
 * about the remote and by `tade setup` on the machine itself.
 */
export function moshPortsSaid(where: string): string {
  return `optional, for mosh: open ${MOSH_PORTS} on ${where} — \`sudo ufw allow 60000:61000/udp\`, and in the provider's firewall too. Without it a terminal to an agent there goes over ssh -t, which the window falls back to by itself`
}

/** How long a mosh terminal is given to be heard from there before ssh is used instead. */
export const MOSH_WITHIN_MS = 6_000

/** How long after mosh did not get through to a remote it is tried again. */
export const MOSH_AGAIN_MS = 60 * 60_000

/** mosh's own words while nothing has come back over UDP, and once it gives up waiting. */
const MOSH_WAITING = /Nothing received from server on UDP port|Timed out waiting for server/

/** Whether a mosh terminal's screen says it is still waiting to hear from there. */
export function moshWaiting(rows: readonly string[]): boolean {
  return rows.some((row) => MOSH_WAITING.test(row))
}

/** ssh's own exit status, which no remote command is passed through as: the connection went. */
export const SSH_LOST = 255

export const MOSH_PROGRAM: RequiredProgram = {
  command: 'mosh',
  title: 'mosh',
  why: `typing into an agent on another machine as if it were here, through a sleep and a change of network — on both machines, with ${MOSH_PORTS} open on the far one`,
  versionArgs: ['--version'],
  optional: true,
  install: { brew: 'mosh', apt: 'mosh', dnf: 'mosh' },
}

export { lineOk } from '@tade/remotes-core'

/** A path `command -v` answered that mosh may be told to run there: one word, nothing a shell expands. */
export function serverOk(path: string): boolean {
  return /^\/[A-Za-z0-9_./+-]+$/.test(path)
}

export interface Attaching {
  /** The ssh to run, and what goes before everything else (a test's `-F`). */
  ssh: string
  before: readonly string[]
  /** The window's master for this remote. */
  control: string
  address: string
  line: string
  /** Where mosh is here and its server there, where both are; null for ssh. */
  mosh: { here: string; there: string } | null
}

/** One argument as a shell reads it, for the ssh command mosh is handed as one string. */
function word(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function attachThere(at: Attaching): TerminalThere {
  // mosh takes a host, never a URI: a destination with a port of its own goes over ssh.
  if (at.mosh !== null && !at.address.startsWith('ssh://')) {
    const ssh = [at.ssh, ...at.before, '-S', at.control, '-o', 'ConnectTimeout=10']
    return {
      command: at.mosh.here,
      args: [
        `--ssh=${ssh.map(word).join(' ')}`,
        `--server=${at.mosh.there}`,
        '--',
        at.address,
        'sh',
        '-c',
        at.line,
      ],
      by: 'mosh',
      proving: { within: MOSH_WITHIN_MS, waiting: moshWaiting },
    }
  }
  return {
    command: at.ssh,
    args: [
      ...at.before,
      '-t',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      '-S',
      at.control,
      '--',
      at.address,
      at.line,
    ],
    by: 'ssh',
    lost: SSH_LOST,
  }
}
