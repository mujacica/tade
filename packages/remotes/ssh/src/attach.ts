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
// `command -v mosh-server` — asked over the window's master, now and then —
// and what the terminal says it reaches by is beside it, so a pane mosh
// cannot get through is a pane that says it is mosh.
//
// **Over the window's master** in both cases (`-S`), so a terminal is a
// session on the connection already up: one or two round trips, not nine.
// Not `BatchMode`: a person is at this one, and a passphrase it asks for is
// theirs to type. `ServerAliveInterval` ends a terminal whose connection died
// in ten seconds, rather than leaving a pane that looks alive.

export const MOSH_PROGRAM: RequiredProgram = {
  command: 'mosh',
  title: 'mosh',
  why: 'typing into an agent on another machine as if it were here, through a sleep and a change of network — on both machines, with UDP 60000–61000 open on the far one',
  versionArgs: ['--version'],
  optional: true,
  install: { brew: 'mosh', apt: 'mosh', dnf: 'mosh' },
}

/** A line a remote shell is handed as it came: one line of printable ASCII, bounded. */
export function lineOk(line: string): boolean {
  return /^[\x20-\x7e]{1,4096}$/.test(line)
}

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
  }
}
