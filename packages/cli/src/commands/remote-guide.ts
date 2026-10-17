import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { type Open, openerForLink } from '@tade/app/editor'
import {
  type Config,
  KEYS_TO_REMOTE,
  loadConfig,
  located,
  machineLabel,
  NewRemoteName,
  OWNER_IS_YOUR_SSH_KEY,
  REMOTE_KEPT_HERE,
  RemoteCommand,
  type RemoteConfig,
  SshDestination,
  TALK_TO_REMOTE,
  writeSetting,
} from '@tade/core'
import { LinkError, type PagesHere, type Remote, type RemoteLink } from '@tade/remotes-core'
import {
  type CarryPress,
  type Checklist,
  carriedLine,
  carryTo,
  checklistLines,
  checklistOf,
  harnessesInUse,
  type Setup,
  setupOf,
  signInNamed,
  withShellJournal,
} from '@tade/workbench/carry'
import { HomeBusyError, heldBy } from '@tade/workbench/lock'
import { linkOf, moshPortsSaid, remoteOf } from '@tade/workbench/remotes'
import { heldIn, recordFromShell } from '../config-write.ts'
import { Exit, type Io } from '../io.ts'

// The guided half of `tade remote add` and `tade remote carry`: meeting a
// machine never met, carrying this one's setup there, offering the keys and
// talking to Tade from here on a press, walking each harness's sign-in, and the
// checklist at the end
// (`@tade/workbench/carry`; `@tade/core`'s `carry.ts` decides every key). And
// `tade remote connect`, which serves that machine's own pages that connect a
// source here, for what is pasted into them (`connectRemote`).
//
// **Every question is a person's.** With nobody at the terminal — `--json`, a
// pipe, an agent's shell — nothing is asked and nothing that needs a press
// happens: a host never met is not met, keys stay where they are and no
// sign-in is started, and what is left is said with the command that does it.

/** How the person is asked, and where a terminal there is run. A test hands its own. */
export interface Asking {
  /** Whether anybody is at this terminal to answer. */
  interactive: boolean
  /** A question with `[y/N]` (or `[Y/n]` where `yes` is the default). */
  ask(question: string, yes: boolean): Promise<boolean>
  /** Run a command here, handing it this terminal; its exit code. */
  run(command: string, args: readonly string[]): Promise<number>
}

/** Asking at this terminal, where there is one. */
export function ttyAsking(json: boolean): Asking {
  const interactive = !json && process.stdin.isTTY === true && process.stderr.isTTY === true
  return {
    interactive,
    ask: async (question, yes) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        rl.setPrompt(`${question} ${yes ? '[Y/n]' : '[y/N]'} `)
        rl.prompt()
        // Iterated rather than `question()`, which never settles at the end of
        // input: ctrl+d is nobody saying yes.
        for await (const line of rl) {
          const said = line.trim()
          return said === '' ? yes : /^y(?:es)?$/i.test(said)
        }
        return false
      } finally {
        rl.close()
      }
    },
    run: (command, args) =>
      new Promise((done) => {
        const child = spawn(located(command), [...args], { stdio: 'inherit' })
        child.on('exit', (code) => done(code ?? 1))
        child.on('error', () => done(127))
      }),
  }
}

/**
 * Meet the machine before anything is sent to it: known goes on; changed
 * stops, said plainly; never met shows what it offers and goes on only on the
 * person's word — a press here, or each fingerprint given with `--accept-key`.
 * Whether to go on.
 */
export async function meet(
  link: RemoteLink,
  address: string,
  io: Io,
  asking: Asking,
  accepted: readonly string[],
): Promise<boolean> {
  if (!link.capabilities.identifies) return true
  let seen: Awaited<ReturnType<RemoteLink['identify']>>
  try {
    seen = await link.identify(address)
  } catch (err) {
    // Not being able to look is not a reason to trust: the connections that
    // follow never accept a host ssh does not know, and say so if it is one.
    io.err(
      `could not look at ${address}'s host key first (${err instanceof Error ? err.message : String(err)}); ssh still refuses one it does not know`,
    )
    return true
  }
  if (seen.state === 'known') return true
  if (seen.state === 'changed') {
    io.err(seen.said)
    return false
  }
  io.err(`${address} is a machine this one has never connected to. It offers:`)
  for (const one of seen.fingerprints) io.err(`  ${one}`)
  io.err(
    `Compare that with what the machine itself says (\`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\` there, or its provider's console). Nothing has been sent to it.`,
  )
  let yes = accepted.length > 0 && seen.fingerprints.every((one) => accepted.includes(one))
  if (accepted.length > 0 && !yes) {
    io.err('the --accept-key given is not what it offers: nothing was written down')
    return false
  }
  if (!yes && asking.interactive) {
    yes = await asking.ask(`Is that ${address}? Trust it, and write it to ${seen.where}`, false)
  }
  if (!yes) {
    if (!asking.interactive && accepted.length === 0) {
      io.err(
        `nobody here to ask: run this in a terminal, or pass --accept-key '<fingerprint>' for each line above`,
      )
    }
    return false
  }
  try {
    const trusted = await link.trust(address, seen.fingerprints)
    io.err(`${address} is trusted now: written to ${trusted.where}`)
    return true
  } catch (err) {
    io.err(err instanceof LinkError ? err.message : String(err))
    return false
  }
}

/** What a carry needs of where it runs. */
export interface Carrying {
  home: string
  configPath: string
  config: Config
  link: RemoteLink
  remote: Remote
  /** What this machine calls itself there. */
  from: string
  io: Io
  asking: Asking
  now: () => number
}

/** Carry this machine's setup there once, and the checklist it comes to. */
export async function carryOnce(
  c: Carrying,
  setup: Setup,
  opts: Omit<CarryPress, 'from'>,
): Promise<Checklist> {
  const inUse = harnessesInUse(c.config)
  try {
    const answer = await carryTo(c.link, c.remote, setup, { from: c.from, ...opts })
    return checklistOf({
      remote: c.remote.name,
      setup,
      answer,
      unreached: null,
      inUse,
      now: c.now(),
    })
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err)
    return checklistOf({
      remote: c.remote.name,
      setup,
      answer: null,
      unreached: said,
      inUse,
      now: c.now(),
    })
  }
}

/**
 * The keys, on the person's press: what they mean said first, then sent, and
 * written down here as sent — which needs this home's journal, so where a
 * window holds it, they are sent from that window instead. The checklist after.
 */
export async function offerKeys(
  c: Carrying,
  setup: Setup,
  list: Checklist,
  pressed: boolean,
): Promise<Checklist> {
  if (list.unreached !== null || list.waiting.length === 0) return list
  // With nobody to ask and no press given ahead, the checklist says what waits and how.
  if (!pressed && !c.asking.interactive) return list
  c.io.err(
    `${list.waiting.length === 1 ? 'This waits' : 'These wait'} on a press: ${list.waiting.join(', ')}`,
  )
  c.io.err(KEYS_TO_REMOTE)
  const yes =
    pressed ||
    (c.asking.interactive && (await c.asking.ask(`Send them to ${c.remote.name} now?`, false)))
  if (!yes) return list
  let sent: Checklist = list
  try {
    await withShellJournal(c.home, async (append) => {
      sent = await carryOnce(c, setup, { keys: true })
      await append(carriedLine(c.remote.name, 'cli', sent))
    })
  } catch (err) {
    if (!(err instanceof HomeBusyError)) throw err
    c.io.err(
      `the window open on this home holds its journal, so they are sent from there: Settings › Remotes › ${c.remote.name}`,
    )
  }
  return sent
}

/**
 * Talking to Tade from here turned on there, on the person's press: what it
 * means said first, then asked for, and written down here as asked — which
 * needs this home's journal, so where a window holds it, it is pressed from
 * that window instead. The checklist after. Only ever offered where that
 * machine said it is off.
 */
export async function offerTalk(
  c: Carrying,
  setup: Setup,
  list: Checklist,
  pressed: boolean,
): Promise<Checklist> {
  if (list.unreached !== null || list.talk !== 'off') return list
  // With nobody to ask and no press given ahead, the checklist says it is off and how.
  if (!pressed && !c.asking.interactive) return list
  c.io.err(
    `Talking to Tade from here is off on ${c.remote.name}, so what you type in its tab here goes nowhere.`,
  )
  c.io.err(TALK_TO_REMOTE)
  const yes =
    pressed ||
    (c.asking.interactive && (await c.asking.ask(`Turn it on on ${c.remote.name} now?`, false)))
  if (!yes) return list
  let turned: Checklist = list
  try {
    await withShellJournal(c.home, async (append) => {
      turned = await carryOnce(c, setup, { keys: false, talk: true })
      await append(carriedLine(c.remote.name, 'cli', turned))
    })
  } catch (err) {
    if (!(err instanceof HomeBusyError)) throw err
    c.io.err(
      `the window open on this home holds its journal, so it is turned on from there: Settings › Remotes › ${c.remote.name}`,
    )
  }
  return turned
}

/**
 * Each harness this machine uses that is not signed in there, walked through
 * its own sign-in in this terminal, over the link — the token goes where that
 * harness keeps it there and never through Tade. The checklist after, read
 * again so it says how each stands now.
 */
export async function guideSignIns(c: Carrying, setup: Setup, list: Checklist): Promise<Checklist> {
  const missing = list.signIns.filter((one) => one.told && !one.signedIn)
  if (missing.length === 0 || !c.asking.interactive || !c.link.capabilities.terminals) return list
  let ran = false
  for (const one of missing) {
    const named = signInNamed(one)
    if (
      !(await c.asking.ask(
        `${named} is not signed in on ${c.remote.name}. Sign it in now, here?`,
        true,
      ))
    ) {
      continue
    }
    const words = [
      'accounts',
      'sign-in',
      one.harness,
      ...(one.account === null ? [] : [one.account]),
    ]
    const terminal = c.link.terminal(c.remote, words)
    if (terminal === null) continue
    c.io.err(
      `${named}'s own sign-in, on ${c.remote.name}: what you type goes there and nowhere else`,
    )
    await c.asking.run(terminal.command, terminal.args)
    ran = true
  }
  return ran ? carryOnce(c, setup, { keys: false }) : list
}

/** The checklist, said: to standard output, or as JSON beside what else the command answers. */
export function sayChecklist(
  io: Io,
  list: Checklist,
  how: { address: string; tade: string },
): void {
  for (const line of checklistLines(list, how)) io.out(line)
}

/** What a remote is, said without its session. */
export function listed(name: string, one: RemoteConfig) {
  return { name, ssh: one.ssh, tade: one.tade, device: one.device, host: one.host }
}

/** What `remote add` is told on its command line. */
export interface AddOpts {
  ssh: string
  tade: string
  label?: string
  json?: boolean
  acceptKey?: string[]
}

/** Where a `remote` command runs: the terminal, the home, and the links. A test hands its own. */
export interface Place {
  io: Io
  setExit: (code: number) => void
  home: string
  configPath: string
  /** The link that reaches a remote of this kind, made for this home. */
  linkFor: (kind: string) => RemoteLink | undefined
  asking: Asking
  now: () => number
}

export async function addRemote(place: Place, name: string, opts: AddOpts): Promise<void> {
  const { io, setExit } = place
  // Each refused for its shape before anything runs: the destination becomes
  // an argument to ssh and the command a word a remote shell reads.
  for (const [what, schema, value] of [
    ['a remote’s name', NewRemoteName, name],
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
  const loadedBefore = await loadConfig(place.configPath)
  if (!loadedBefore.ok) {
    io.err(
      `${place.configPath} could not be read: \`tade config --check\` says what is wrong with it`,
    )
    setExit(Exit.error)
    return
  }
  if (loadedBefore.config.remotes[name] !== undefined) {
    io.err(`there is already a remote called ${name}: \`tade remote remove ${name}\` first`)
    setExit(Exit.invalidInput)
    return
  }
  const link = place.linkFor(linkOf({ ssh: opts.ssh } as RemoteConfig))
  if (link === undefined) {
    io.err('there is no link here that reaches a remote over SSH')
    setExit(Exit.error)
    return
  }
  // The machine is met first, and nothing is sent to one the person has not
  // said is the one they meant.
  if (!(await meet(link, opts.ssh, io, place.asking, opts.acceptKey ?? []))) {
    io.err(`nothing was sent to ${opts.ssh}, and ${name} was not added`)
    setExit(Exit.error)
    return
  }
  const label = opts.label ?? machineLabel()
  let session: Awaited<ReturnType<typeof link.pair>>
  try {
    session = await link.pair({ address: opts.ssh, tade: opts.tade, label })
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
  const path = place.configPath
  const held = heldIn(path)
  const kept = { ...written, ...(opts.tade === 'tade' ? { tade: undefined } : {}) }
  writeSetting(path, `remotes.${name}`, kept)
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
  await recordFromShell(path, held, [{ key: `remotes.${name}`, value: kept }], io.err, place.home)
  const window = (await heldBy(place.home)) !== null
  if (!opts.json) {
    io.out(
      `${name}: this machine is an owner of the Tade at ${opts.ssh}, as device ${session.device}`,
    )
  }
  io.err(REMOTE_KEPT_HERE)
  io.err(OWNER_IS_YOUR_SSH_KEY)
  // Then what this machine was set up with, carried there, and what is left.
  const c: Carrying = {
    home: place.home,
    configPath: path,
    config: loaded.config,
    link,
    remote: remoteOf(name, loaded.config.remotes[name]),
    from: label,
    io,
    asking: place.asking,
    now: place.now,
  }
  const setup = await setupOf(place.home, path)
  let list = await carryOnce(c, setup, { keys: false })
  list = await offerKeys(c, setup, list, false)
  list = await offerTalk(c, setup, list, false)
  list = await guideSignIns(c, setup, list)
  if (opts.json) {
    io.out(JSON.stringify({ ...listed(name, written), window, checklist: list }, null, 2))
    return
  }
  sayChecklist(io, list, { address: opts.ssh, tade: opts.tade })
  if (link.capabilities.terminals) io.out(moshPortsSaid(opts.ssh))
  io.out(
    window
      ? 'the window open on this home links it within a few seconds and keeps it in step: `tade remote status` says how it stands'
      : 'it is linked, and kept in step, while a window is open on this home: `tade app`, then `tade remote status`',
  )
}

/** `tade remote carry`: the same carry again, the keys on a press, and the checklist. */
export async function carryRemote(
  place: Place,
  name: string,
  opts: { keys?: boolean; talk?: boolean; yes?: boolean; ours?: string[]; json?: boolean },
): Promise<void> {
  const { io, setExit } = place
  const found = await configuredRemote(place, name)
  if (found === null) return
  const { config, one, link } = found
  const c: Carrying = {
    home: place.home,
    configPath: place.configPath,
    config,
    link,
    remote: remoteOf(name, one),
    from: machineLabel(),
    io,
    asking: place.asking,
    now: place.now,
  }
  const setup = await setupOf(place.home, place.configPath)
  let list = await carryOnce(c, setup, { keys: false, force: opts.ours ?? [] })
  if (opts.keys) list = await offerKeys(c, setup, list, opts.yes === true)
  if (opts.talk) list = await offerTalk(c, setup, list, opts.yes === true)
  list = await guideSignIns(c, setup, list)
  if (opts.json) io.out(JSON.stringify(list, null, 2))
  else sayChecklist(io, list, { address: one.ssh, tade: one.tade })
  if (list.unreached !== null) setExit(Exit.error)
}

/** A remote in the config and the link that reaches it, or null having said why not. */
async function configuredRemote(
  place: Place,
  name: string,
): Promise<{ config: Config; one: RemoteConfig; link: RemoteLink } | null> {
  const { io, setExit } = place
  const loaded = await loadConfig(place.configPath)
  if (!loaded.ok) {
    io.err(
      `${place.configPath} could not be read: \`tade config --check\` says what is wrong with it`,
    )
    setExit(Exit.error)
    return null
  }
  const one = loaded.config.remotes[name]
  if (one === undefined) {
    io.err(`there is no remote called ${name}`)
    setExit(Exit.invalidInput)
    return null
  }
  const link = place.linkFor(linkOf(one))
  if (link === undefined) {
    io.err(`there is no link here that reaches ${name}`)
    setExit(Exit.error)
    return null
  }
  return { config: loaded.config, one, link }
}

/** What holding a remote's pages open does with this machine: a test opens nothing and ends it. */
export interface Holding {
  /** Hands the address to this machine's browser. */
  open: Open
  /** Settles when they should stop being served: ctrl+c, from a terminal. */
  until: () => Promise<void>
}

/** Said beside the address, because it is still a port on this machine while it is open. */
export const PAGES_ARE_OPEN_HERE =
  'while this runs, anybody with an account on this machine can open them too, as through `ssh -L`: ctrl+c stops serving them'

/**
 * `tade remote connect`: that machine's own pages that connect a source,
 * served here and opened in this machine's browser until ctrl+c
 * (`RemoteLink.pages`) — where what a source's own page shows the person is
 * pasted, because it is never carried there from here (Settings › Remotes).
 * The address goes to standard output, everything said to standard error.
 */
export async function connectRemote(
  place: Place,
  name: string,
  opts: { open?: boolean },
  holding: Holding,
): Promise<void> {
  const { io, setExit } = place
  const found = await configuredRemote(place, name)
  if (found === null) return
  let pages: PagesHere
  try {
    pages = await found.link.pages(remoteOf(name, found.one))
  } catch (err) {
    io.err(`${name}'s pages could not be served here: ${err instanceof Error ? err.message : err}`)
    setExit(Exit.error)
    return
  }
  try {
    io.out(pages.url)
    io.err(
      `${name}'s own pages that connect a source, served here: what a source's page shows you is pasted into them`,
    )
    io.err(PAGES_ARE_OPEN_HERE)
    const opener = opts.open === false ? null : openerForLink(pages.url)
    if (opener?.kind === 'detached') {
      await holding.open(opener).catch((err: unknown) => {
        io.err(
          `no browser opened here (${err instanceof Error ? err.message : err}): open ${pages.url}`,
        )
      })
    }
    await holding.until()
  } finally {
    await pages.close()
  }
}
