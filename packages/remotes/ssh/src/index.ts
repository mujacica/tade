import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import {
  located,
  printable,
  type RequiredProgram,
  resolveCommand,
  runProgram,
  runtimeDir,
} from '@tade/core'
import {
  DIAL_MS,
  type Door,
  LinkError,
  type LinkOptions,
  linkOver,
  type OwnerSession,
  type PairAt,
  type Paired,
  type Reaching,
  type Remote,
  type RemoteLink,
  type RepositoryThere,
  type TerminalThere,
} from '@tade/remotes-core'
import {
  attachThere,
  KNOWN_ONLY,
  lineOk,
  MOSH_AGAIN_MS,
  MOSH_PROGRAM,
  NO_AGENT,
  serverOk,
} from './attach.ts'
import { changedSays, identify, trust } from './known.ts'
import {
  AUTHORIZED_KEYS,
  accepted,
  blobOf,
  commentFor,
  forget,
  INSTALL,
  keyable,
  keyOf,
  mint,
  publicLine,
  REMOVE,
  signInArgs,
} from './own-key.ts'

export { KNOWN_ONLY, MOSH_PORTS, MOSH_PROGRAM, moshPortsSaid, NO_AGENT } from './attach.ts'

// A RemoteLink over SSH: the one way there is to reach another machine's Tade
// today.
//
// **One connection per remote, and everything rides it.** A ControlMaster is
// started once (`ssh -M -f -N`) with a forward from a Unix socket here to the
// remote's loopback listener, and the away stream, every presence and every
// later session — an attached terminal, a `git fetch` — go through that one
// connection: a fresh SSH session is seven to nine round trips to a shell, and
// one over a live master is one or two.
//
// **The forward ends in a Unix socket, not a port.** A TCP port on loopback is
// open to every user of this machine; a socket made `0600` in a `0700` folder
// (`StreamLocalBindMask`, `runtimeDir`) is open to you. What reaches the
// remote through it is an owner session, which is your keyboard there, so the
// door to it should be no wider than your own files.
//
// **It never asks anybody anything.** `BatchMode` is on for every connection,
// because the window draws on the thread that would wait for an answer and
// there is nobody at a terminal to give one: a key that needs a passphrase not
// in the agent, a password — each fails at once with ssh's own words and what
// to do. A key that needs a touch still works: a touch is not a prompt. **A
// host never met is the one question that is asked**, and not here: `tade
// remote add` shows its key and writes it down on the person's press
// (`known.ts`), before anything is sent to it. The one place a person types
// into ssh is the terminal a harness's sign-in runs in (`terminal`), which is
// theirs to see.
//
// **What it runs is shaped before it gets here** (`@tade/core`'s `remotes.ts`):
// a destination never starts with `-`, and the remote command is one word. Both
// are checked again here, because this is where they become arguments, and the
// label a remote shell reads is quoted.

export interface SshOptions extends LinkOptions {
  /** The ssh to run. `ssh` on PATH unless a test names another. */
  ssh?: string
  /** Put before everything else: a test's `-F <config>`, which is where its keys are. */
  args?: readonly string[]
  /** The environment ssh runs with. Tade's own when not given. */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * Where a remote's sshd reads the keys it takes, from that user's home:
   * `.ssh/authorized_keys` unless a test names its own sshd's, so the suite
   * never writes into the home of whoever runs it.
   */
  authorizedKeys?: string
}

export const SSH_PROGRAM: RequiredProgram = {
  command: 'ssh',
  title: 'OpenSSH',
  why: 'reaching another machine’s Tade, and pairing with one',
  versionArgs: ['-V'],
  // Every Mac has one, and so does nearly every Linux with a shell on it —
  // but "macOS ships with it" is no answer to an Arch box without it.
  install: {
    apt: 'openssh-client',
    dnf: 'openssh-clients',
    instead: { darwin: 'macOS ships with it' },
  },
}

/**
 * What every connection is held to: never asks, never hands the far end this
 * machine's SSH agent (`NO_AGENT`), meets no host it was not told of
 * (`KNOWN_ONLY`), notices a dead link in ten seconds.
 */
const QUIET = [
  ...NO_AGENT,
  ...KNOWN_ONLY,
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=5',
  '-o',
  'ServerAliveCountMax=2',
]

/** How long pairing or signing out may take: a connection, a sign-in, and a short command there. */
const ASK_MS = 30_000

export function makeSshLink(options: SshOptions): RemoteLink {
  const ssh = new Ssh(options)
  return linkOver(
    {
      id: 'ssh',
      capabilities: { pairs: true, identifies: true, terminals: true, fetches: true },
      programs: [SSH_PROGRAM, MOSH_PROGRAM],
      pair: (at) => ssh.pair(at),
      unpair: (remote) => ssh.unpair(remote),
      reaching: (remote) => ssh.reaching(remote),
      connect: (remote) => ssh.connect(remote),
      identify: (address) => {
        checked(address, 'tade')
        return identify((args, ms) => ssh.runArgs(args, ms), address)
      },
      trust: (address, fingerprints) => {
        checked(address, 'tade')
        return trust((args, ms) => ssh.runArgs(args, ms), address, fingerprints)
      },
      terminal: (remote, words) => ssh.terminal(remote, words),
      attach: (remote, line) => ssh.attach(remote, line),
      attached: (remote, by, through) => ssh.attached(remote, by, through),
      repository: (remote, root) => ssh.repository(remote, root),
    },
    options,
  )
}

/** A destination ssh reads as a destination, never as an option. */
export function destinationOk(address: string): boolean {
  return /^(?:ssh:\/\/)?[A-Za-z0-9_][A-Za-z0-9._@:-]*$/.test(address)
}

/** One word a remote shell reads as a command: no space, no quote, nothing it would expand but `~`. */
export function commandOk(command: string): boolean {
  return /^[A-Za-z0-9_~./+][A-Za-z0-9_~./+-]*$/.test(command)
}

/** A value as one argument to a remote shell. */
export function quoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The arguments that start a master with its forward, for one remote, signing in with `signIn`. */
export function masterArgs(
  paths: Paths,
  port: number,
  address: string,
  signIn: readonly string[] = [],
): string[] {
  return [
    '-M',
    '-S',
    paths.control,
    '-f',
    '-N',
    '-T',
    ...QUIET,
    ...signIn,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'StreamLocalBindMask=0177',
    '-L',
    `${paths.forward}:127.0.0.1:${port}`,
    '--',
    address,
  ]
}

/** Where one remote's master listens for this home's ssh, and where its forward ends. */
export interface Paths {
  control: string
  forward: string
}

/**
 * Short and per home, because a Unix socket's path is capped near 104 bytes
 * and a runtime folder under macOS's temp is half of that already: the name is
 * a hash, the port is in the forward's so a remote that moved its listener is a
 * new forward rather than an old one pointing at nothing.
 */
export function pathsFor(home: string, remote: string, port: number): Paths {
  const control = controlOf(home, remote)
  return { control, forward: control.replace(/\.ctl$/, `-${port}.sock`) }
}

/** Where one remote's master listens, whatever port its forward reaches. */
function controlOf(home: string, remote: string): string {
  const short = createHash('sha1').update(remote).digest('hex').slice(0, 8)
  return join(runtimeDir(home), `r-${short}.ctl`)
}

/**
 * Where it is written down that mosh did not get through to one remote: an
 * empty file, as old as the try. Beside the master's socket, so a window
 * opened again remembers it and a machine started again does not — another
 * boot is as likely another network.
 */
export function moshRefusedAt(home: string, remote: string): string {
  return controlOf(home, remote).replace(/\.ctl$/, '.nomosh')
}

/** How long what a remote answered about its mosh is kept before it is asked again. */
const MOSH_KEPT_MS = 10 * 60_000

class Ssh {
  private readonly options: SshOptions
  /** Each remote's `mosh-server`, as it last answered, and when. */
  private readonly moshThere = new Map<string, { at: number; path: string | null }>()

  constructor(options: SshOptions) {
    this.options = options
  }

  private run(args: readonly string[], timeoutMs: number) {
    return runProgram(this.options.ssh ?? 'ssh', [...(this.options.args ?? []), ...args], {
      timeoutMs,
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
    })
  }

  /** This link's own key for one remote, where it can have one: `keyOf`. */
  private keyFor(remote: string): string | null {
    // A name the config could not hold has no key: it signs in as ssh would.
    return keyable(remote) ? keyOf(this.options.home, remote) : null
  }

  /** What every connection to this remote signs in with: its own key alone, where it has one. */
  private signIn(remote: string): string[] {
    const key = this.keyFor(remote)
    return key === null ? [] : signInArgs(key)
  }

  /** ssh with these arguments after the link's own, for the host-key looks. */
  runArgs(args: readonly string[], timeoutMs: number) {
    return this.run(args, timeoutMs)
  }

  /**
   * A stream to the remote's loopback listener for one call: `ssh -W`, over
   * the master the window holds where there is one (`-S`; ssh connects by
   * itself where nothing answers on it), and gone when the call is. Never the
   * master: a call from a shell must not start one nobody ends, nor end the
   * one a window is reading.
   */
  async connect(remote: Remote): Promise<Duplex> {
    checked(remote.address, remote.tade)
    const port = portOf(remote.session.host)
    const env = { ...(this.options.env ?? process.env) }
    const child = spawn(
      located(this.options.ssh ?? 'ssh', env),
      [
        ...(this.options.args ?? []),
        ...QUIET,
        ...this.signIn(remote.name),
        '-S',
        controlOf(this.options.home, remote.name),
        '-W',
        `127.0.0.1:${port}`,
        '--',
        remote.address,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env },
    )
    let said = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      said = `${said}${chunk}`.slice(-4_096)
    })
    // Node takes a pair of its own streams here; the types know only the web's.
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin } as never)
    child.on('error', () => {
      stream.destroy(new LinkError('missing', 'there is no ssh on this machine'))
    })
    child.on('exit', (code) => {
      if (code === 0 || code === null) return
      if (/open failed|stdio forwarding failed/i.test(said)) {
        stream.destroy(
          new LinkError(
            'failed',
            `nothing answers on ${remote.session.host} there: its Tade is not open, or its away view is off`,
          ),
        )
        return
      }
      try {
        trouble(
          { code, stderr: said, timedOut: false, missing: false },
          remote.address,
          remote.tade,
          this.signIn(remote.name).length > 0,
        )
      } catch (err) {
        stream.destroy(err as Error)
      }
    })
    // `kill` answers false for one already gone, and ssh -W starts nothing of its own.
    stream.on('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM')
    })
    return stream
  }

  /**
   * A terminal there running Tade with these words, typed into here: `ssh -t`,
   * over the window's master where there is one. Not `BatchMode`: this is the
   * one connection a person is at, so a passphrase it asks for is theirs to
   * type.
   */
  terminal(remote: Remote, words: readonly string[]): TerminalThere {
    checked(remote.address, remote.tade)
    for (const word of words) {
      if (!/^[A-Za-z0-9_.@:-]+$/.test(word)) {
        throw new LinkError(
          'failed',
          `${JSON.stringify(word)} is not a word this link passes to a shell`,
        )
      }
    }
    return {
      command: this.options.ssh ?? 'ssh',
      args: [
        ...(this.options.args ?? []),
        '-t',
        ...NO_AGENT,
        ...KNOWN_ONLY,
        ...this.signIn(remote.name),
        '-o',
        'ConnectTimeout=10',
        '-S',
        controlOf(this.options.home, remote.name),
        '--',
        remote.address,
        commandThere(remote.tade, words.join(' ')),
      ],
    }
  }

  /**
   * How git here fetches a repository there: `ssh://<address><root>`, with
   * git's ssh made this link's — the same options, `BatchMode`, and the
   * window's master where there is one (`-S`), which it never becomes itself
   * (`ControlMaster=no`): a fetch from a shell must not start a master nobody
   * ends. Every word is quoted, because git hands `GIT_SSH_COMMAND` to a shell.
   */
  repository(remote: Remote, root: string): RepositoryThere {
    checked(remote.address, remote.tade)
    const words = [
      this.options.ssh ?? 'ssh',
      ...(this.options.args ?? []),
      ...QUIET,
      ...this.signIn(remote.name),
      '-o',
      'ControlMaster=no',
      '-S',
      controlOf(this.options.home, remote.name),
    ]
    const destination = remote.address.startsWith('ssh://')
      ? remote.address
      : `ssh://${remote.address}`
    return {
      url: `${destination}${root}`,
      env: {
        GIT_SSH_COMMAND: words.map(quoted).join(' '),
        GIT_SSH_VARIANT: 'ssh',
        GIT_TERMINAL_PROMPT: '0',
      },
    }
  }

  /**
   * A terminal there running the line that machine gave for one of its agents
   * (`attach.ts`): over mosh where both machines have it, `ssh -t` otherwise.
   */
  async attach(remote: Remote, line: string): Promise<TerminalThere> {
    checked(remote.address, remote.tade)
    if (!lineOk(line)) {
      throw new LinkError(
        'failed',
        `${remote.name} answered a line this link would not hand a shell: ${JSON.stringify(printable(line).slice(0, 80))}`,
      )
    }
    const env = this.options.env ?? process.env
    const here = (await this.moshRefused(remote))
      ? null
      : resolveCommand('mosh', { PATH: env.PATH ?? '' })
    const there = here === null ? null : await this.moshServer(remote)
    return attachThere({
      ssh: this.options.ssh ?? 'ssh',
      before: [...(this.options.args ?? []), ...this.signIn(remote.name)],
      control: controlOf(this.options.home, remote.name),
      address: remote.address,
      line,
      mosh: here !== null && there !== null ? { here, there } : null,
    })
  }

  /**
   * What came of a mosh terminal: one that did not get through is written
   * down, so the next terminal to that remote goes over ssh at once rather
   * than waiting on mosh's banner again; one that did takes that back. ssh is
   * proved by nothing, so nothing is said of it.
   */
  async attached(remote: Remote, by: string, through: boolean): Promise<void> {
    if (by !== 'mosh') return
    const at = moshRefusedAt(this.options.home, remote.name)
    if (through) {
      await rm(at, { force: true })
      return
    }
    await mkdir(join(at, '..'), { recursive: true, mode: 0o700 })
    await writeFile(at, '')
  }

  /** Whether mosh did not get through to this remote within the last `MOSH_AGAIN_MS`. */
  private async moshRefused(remote: Remote): Promise<boolean> {
    try {
      const at = await stat(moshRefusedAt(this.options.home, remote.name))
      return Date.now() - at.mtimeMs < MOSH_AGAIN_MS
    } catch (err) {
      // Nothing written down is the usual answer, and means mosh is tried.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  /**
   * Where `mosh-server` is there, as a command over SSH finds it — which is
   * how mosh itself starts it — or null. Asked over the window's master and
   * kept a while, so pressing enter on an agent is not a round trip more.
   */
  private async moshServer(remote: Remote): Promise<string | null> {
    const kept = this.moshThere.get(remote.name)
    const now = Date.now()
    if (kept !== undefined && now - kept.at < MOSH_KEPT_MS) return kept.path
    const ran = await this.run(
      [
        ...QUIET,
        ...this.signIn(remote.name),
        '-S',
        controlOf(this.options.home, remote.name),
        '--',
        remote.address,
        'command -v mosh-server',
      ],
      10_000,
    )
    const said = ran.code === 0 ? (ran.stdout.trim().split('\n')[0]?.trim() ?? '') : ''
    const path = serverOk(said) ? said : null
    this.moshThere.set(remote.name, { at: now, path })
    return path
  }

  /**
   * Run `tade web pair --owner` there, and read back what it printed once —
   * then, where asked, give the link a key of its own there (`own-key.ts`).
   */
  async pair(at: PairAt): Promise<Paired> {
    checked(at.address, at.tade)
    const ran = await this.run(
      [
        ...QUIET,
        '--',
        at.address,
        commandThere(at.tade, `web pair --owner --json --label ${quoted(at.label.slice(0, 120))}`),
      ],
      ASK_MS,
    )
    trouble(ran, at.address, at.tade)
    const session: OwnerSession = sessionIn(ran.stdout, at.address)
    if (at.ownCredentialFor === undefined) return session
    return { ...session, signsIn: await this.ownKey(at, at.ownCredentialFor) }
  }

  /**
   * Mint this link's own key, write it there over what reached the machine
   * just now, and prove it signs in — answering, whatever came of it, what
   * the person is to be told. Nothing here fails the pairing: a link that
   * could not have its own key signs in as it did a moment ago.
   */
  private async ownKey(at: PairAt, name: string): Promise<string> {
    const before = `${at.address} is signed into as before, with whatever ssh reaches it by`
    const key = this.keyFor(name)
    if (key === null) return `${name} cannot have a key of its own, so ${before}`
    const comment = commentFor(at.label, name)
    let line: string
    try {
      line = await mint(key, comment)
    } catch (err) {
      return `no key of its own could be made for ${name} (${(err as Error).message}), so ${before}`
    }
    const file = this.options.authorizedKeys ?? AUTHORIZED_KEYS
    const installed = await this.run(
      [...QUIET, '--', at.address, remoteSh(INSTALL, file, line)],
      ASK_MS,
    )
    if (installed.code !== 0) {
      await forget(key)
      const said = lastLine(installed.stderr) || `it exited ${installed.code}`
      return `${name}’s own key could not be written to ${keptAt(file)} there (${said}), so ${before}`
    }
    // A sign-in of its own, never over a master the person's config may hold
    // open: one riding that would prove the key it signed in with, not this one.
    const proved = await this.run(
      [
        ...QUIET,
        ...signInArgs(key),
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '-v',
        '--',
        at.address,
        'true',
      ],
      ASK_MS,
    )
    if (proved.code === 0 && accepted(proved.stderr, key)) {
      return `${name} signs in there with a key of its own, ${key}, written to ${keptAt(file)} there as the line ending \`${comment}\`: taking that line out takes this machine’s way in away and leaves every other key alone, and \`tade remote remove ${name}\` takes it out by itself`
    }
    // That machine reads its keys from somewhere else: the line is taken back
    // out rather than left where it means nothing.
    await this.run([...QUIET, '--', at.address, remoteSh(REMOVE, file, blobOf(line))], ASK_MS)
    await forget(key)
    return `${at.address} would not sign in with ${name}’s own key from ${keptAt(file)} — it reads the keys it takes from somewhere else — so it was taken back out, and ${before}`
  }

  /**
   * Run `tade web revoke <device>` there, and take this link's own key back
   * out of that machine and this one, where it has one.
   */
  async unpair(remote: Remote): Promise<void> {
    checked(remote.address, remote.tade)
    if (!/^[0-9a-f]{8,64}$/.test(remote.session.device)) {
      throw new LinkError('failed', 'that is not a device id this link would pass to a shell')
    }
    const key = this.keyFor(remote.name)
    const signIn = this.signIn(remote.name)
    const file = this.options.authorizedKeys ?? AUTHORIZED_KEYS
    const ran = await this.run(
      [
        ...QUIET,
        ...signIn,
        '--',
        remote.address,
        commandThere(remote.tade, `web revoke ${remote.session.device}`),
      ],
      ASK_MS,
    )
    try {
      trouble(ran, remote.address, remote.tade, signIn.length > 0)
    } catch (err) {
      if (key === null || signIn.length === 0 || !(err instanceof LinkError)) throw err
      throw new LinkError(
        err.problem,
        `${err.message} — and ${remote.name}’s own key is still in ${keptAt(file)} there, the line ending \`${await commentOf(key)}\`, and in ${key} here`,
      )
    }
    if (key === null || signIn.length === 0) return
    let line: string
    try {
      line = await publicLine(key)
    } catch (err) {
      throw new LinkError(
        'failed',
        `signed out there, but ${remote.name}’s own key could not be read here to take it out of ${keptAt(file)} there: ${(err as Error).message}`,
      )
    }
    const removed = await this.run(
      [...QUIET, ...signIn, '--', remote.address, remoteSh(REMOVE, file, blobOf(line))],
      ASK_MS,
    )
    if (removed.code !== 0) {
      const said = lastLine(removed.stderr) || `it exited ${removed.code}`
      throw new LinkError(
        'failed',
        `signed out there, but ${remote.name}’s own key could not be taken out of ${keptAt(file)} there (${said}): take out the line ending \`${line.split(' ')[2] ?? ''}\` by hand, then delete ${key} here`,
      )
    }
    await forget(key)
  }

  reaching(remote: Remote): Reaching {
    // Worked out at each dial and never here, so a session that cannot be
    // linked is a link that is down with the reason, not an `open` that threw.
    const paths = () => pathsFor(this.options.home, remote.name, portOf(remote.session.host))
    // One turn at a time, per remote: a wake that drops the master while a dial
    // is still signing in would otherwise start a second master over the first.
    // Each caller gets its own answer, failure included; the turn only orders.
    let turn: Promise<void> = Promise.resolve()
    const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
      const before = turn
      let done = () => {}
      turn = new Promise((resolve) => {
        done = resolve
      })
      await before
      try {
        return await work()
      } finally {
        done()
      }
    }
    return {
      reach: () => inTurn(() => this.up(remote, paths(), portOf(remote.session.host))),
      drop: () => inTurn(() => this.down(remote, controlOf(this.options.home, remote.name))),
    }
  }

  /** The master, up with its forward: the one already running, or a new one. */
  private async up(remote: Remote, paths: Paths, port: number): Promise<Door> {
    checked(remote.address, remote.tade)
    const door = { socketPath: paths.forward }
    const check = await this.run(['-S', paths.control, '-O', 'check', '--', remote.address], 5_000)
    if (check.code === 0 && existsSync(paths.forward)) return door
    // Alive without its forward is a master somebody else started on this
    // path, or one whose forward was taken away: neither is ours to trust.
    if (check.code === 0) await this.down(remote, paths.control)
    await mkdir(join(paths.control, '..'), { recursive: true, mode: 0o700 })
    const signIn = this.signIn(remote.name)
    const ran = await this.run(masterArgs(paths, port, remote.address, signIn), DIAL_MS - 5_000)
    trouble(ran, remote.address, remote.tade, signIn.length > 0)
    return door
  }

  /** Let the master go, if there is one. Nothing is said: there may be none. */
  private async down(remote: Remote, control: string): Promise<void> {
    if (!destinationOk(remote.address)) return
    await this.run(['-S', control, '-O', 'exit', '--', remote.address], 5_000)
  }
}

function checked(address: string, tade: string): void {
  if (!destinationOk(address)) {
    throw new LinkError(
      'failed',
      `${JSON.stringify(address)} is not an SSH destination this link would run`,
    )
  }
  if (!commandOk(tade)) {
    throw new LinkError(
      'failed',
      `${JSON.stringify(tade)} is not one word a remote shell would read as a command`,
    )
  }
}

function portOf(host: string): number {
  const port = Number(/^localhost:(\d{1,5})$/.exec(host)?.[1] ?? Number.NaN)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new LinkError(
      'failed',
      `a session bound to ${host} is not one for a remote’s own listener`,
    )
  }
  return port
}

/**
 * What a run came to, thrown as the sentence to act on — or nothing, for a run
 * that worked.
 *
 * ssh's own exit is 255; anything else is the remote command's. The last line
 * of ssh's own complaint is the one that says why, so it is the one kept, and
 * the three that somebody can fix with one command by hand say that command.
 */
function trouble(
  ran: { code: number; stderr: string; timedOut: boolean; missing: boolean },
  address: string,
  tade: string,
  ownKey = false,
): void {
  if (ran.missing) throw new LinkError('missing', 'there is no ssh on this machine')
  if (ran.timedOut) throw new LinkError('timed out', `${address} did not answer in time`)
  if (ran.code === 0) return
  const said = lastLine(ran.stderr)
  if (ran.code === 255) {
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(ran.stderr)) {
      throw new LinkError('failed', changedSays(address))
    }
    if (/host key verification failed/i.test(ran.stderr)) {
      throw new LinkError(
        'failed',
        `${said} — this machine has never met ${address}: \`tade remote add\` shows its key and asks before anything is sent`,
      )
    }
    if (ownKey && /permission denied/i.test(ran.stderr)) {
      // Its own key alone is what it offered, so this is that line gone there:
      // somebody took this machine's way in away, which is what the key is for.
      throw new LinkError(
        'failed',
        `${said} — ${address} no longer takes this link’s own key: its line in that machine’s authorized_keys was taken out. \`tade remote remove\` it here, and add it again if that was not meant`,
      )
    }
    if (/permission denied|passphrase|password/i.test(ran.stderr)) {
      throw new LinkError(
        'failed',
        `${said} — a key this link may use without asking (in the agent, or one needing a touch) is what it needs`,
      )
    }
    throw new LinkError('failed', said === '' ? `ssh could not reach ${address}` : said)
  }
  if (ran.code === 127) {
    throw new LinkError(
      'missing',
      `there, \`${tade}\` or the node it runs on is not on the PATH a command over SSH gets${tade === TADE ? ' nor in ~/.local/bin' : ''} — name its whole path with --tade, or put both on the PATH in that machine’s ~/.zshenv or ~/.bashrc`,
    )
  }
  throw new LinkError('failed', said === '' ? `${tade} there exited ${ran.code}` : `there: ${said}`)
}

/** The command a remote is linked with where nobody named one (`remotes.<name>.tade`). */
const TADE = 'tade'

/**
 * Where `tade` is when PATH over SSH does not have it: the folder our own
 * installer puts it in when npm's global one is root's (`npm_place` in
 * `scripts/install.sh`), which only a login profile puts on PATH — and a
 * command over SSH is not a login.
 */
const LOOKED_IN = '$HOME/.local/bin'

/**
 * The line a remote's shell runs for `tade <words>`: the command as named, or,
 * where nobody named one, `tade` from that PATH and then from `LOOKED_IN` —
 * by `sh`, because the person's shell may be fish. `words` is already what a
 * shell reads as arguments. Found in neither, `sh` exits 127, as a command
 * not found always has.
 *
 * `LOOKED_IN` goes on the end of PATH **whichever `tade` runs**, named or not,
 * because what Tade starts there is found by that PATH too: a harness put in
 * `~/.local/bin` beside it (`npm install --global --prefix ~/.local`) was
 * otherwise `claude` not found, and a remote's sign-in failed with it, for a
 * `tade` named whole or one found elsewhere on PATH.
 */
export function commandThere(tade: string, words: string): string {
  const onPath = `case ":$PATH:" in *":${LOOKED_IN}:"*) ;; *) PATH="$PATH:${LOOKED_IN}" ;; esac`
  return `sh -c ${quoted(`${onPath}; exec ${tade} "$@"`)} ${TADE} ${words}`
}

/** One script run there by `sh`, its arguments each one quoted word: the person's shell may be fish. */
function remoteSh(script: string, file: string, arg: string): string {
  return `sh -c ${quoted(script)} tade-link ${quoted(file)} ${quoted(arg)}`
}

/** Where that machine keeps the keys it takes, as the person would type it there. */
function keptAt(file: string): string {
  return file.startsWith('/') ? file : `~/${file}`
}

/** The comment on this link's own key, for saying which line is its — or why it could not be read. */
async function commentOf(key: string): Promise<string> {
  return publicLine(key).then(
    (line) => line.split(' ')[2] ?? '',
    (err: unknown) => `(which could not be read here: ${(err as Error).message})`,
  )
}

/**
 * The line of what ssh and the command there printed that says why, as text:
 * a remote's shell writes it, and the window and the CLI both say it.
 */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => printable(line).trim())
    .filter((line) => line !== '' && !/^Warning: Permanently added/.test(line))
  return (lines.at(-1) ?? '').slice(0, 300)
}

/** The session `tade web pair --owner --json` printed: the credential alone, on standard output. */
export function sessionIn(stdout: string, address: string): OwnerSession {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new LinkError(
      'missing',
      `what answered on ${address} did not print an owner session: it needs a Tade with \`tade web pair --owner\`, which 0.2.3 does not have`,
    )
  }
  const cookie = typeof value.cookie === 'string' ? value.cookie.replace(/^[^=]*=/, '') : ''
  const { device, csrf, host } = value
  if (
    typeof device !== 'string' ||
    typeof csrf !== 'string' ||
    typeof host !== 'string' ||
    !/^localhost:\d{1,5}$/.test(host) ||
    !cookie.startsWith(`${device}.`)
  ) {
    throw new LinkError('failed', `${address} printed something that is not an owner session`)
  }
  return { device, cookie, csrf, host }
}
