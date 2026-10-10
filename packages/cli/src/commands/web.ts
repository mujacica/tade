import {
  DEVICES_AND_AGENTS,
  defaultConfigPath,
  INSTALLED_IS_NOT_REVOCABLE,
  INSTALLED_IS_NOT_REVOCABLE_SHORT,
  LAN_IS_PLAINTEXT,
  loadConfig,
  OFFLINE_NEEDS_HTTPS,
  PUSH_IS_WHILE_OPEN,
  PUSH_NEEDS_A_GESTURE,
  tadeHome,
  writeSetting,
} from '@tade/core'
import {
  appendDevice,
  type Device,
  devicesPath,
  reachOf,
  readDevices,
  readsOf,
  revokeAll,
  surfaceOf,
} from '@tade/web'
import { heldBy } from '@tade/workbench/lock'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// `tade web` — what the away view is, who is paired, and turning it off.
//
// **Nothing here opens the workbench**, which is the rule that questions never
// need the window: `status`, `devices` and `revoke` read `config.yaml` and
// `web-devices.jsonl` directly, so they answer with a window open on this home
// and with none. That matters most for `revoke`: disconnecting a phone you
// have lost must not depend on Tade being open, and the device list is
// append-only and keyed by device, so a line written here and a line written
// by the window fold to the same answer whichever order they land in. Nothing
// here rewrites the file, which is what makes that true rather than lucky.
//
// **`on` and `off` write a setting and say when it takes effect.** The
// listener comes up when the window starts — the epoch a connected phone
// holds is per server start — so turning it on while a window is open is
// honestly reported as *next time Tade starts* rather than silently doing
// nothing.
//
// **`pair` needs the window**, because it is the window that mints the ticket
// and the person at the machine who answers it. With no window open it says
// so, which is the whole of what it can honestly do.

export function registerWeb(program: Command, io: Io, setExit: (code: number) => void): void {
  const web = program
    .command('web')
    .description('The away view: one page, from this machine, to a phone you paired')

  web
    .command('status', { isDefault: true })
    .description('Whether anything is listening, and which devices are paired')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const said = await look()
      if (opts.json) {
        io.out(JSON.stringify(said, null, 2))
        return
      }
      for (const line of lines(said)) io.out(line)
    })

  web
    .command('on')
    .description('Serve the away view, for devices you pair at the machine')
    .option('--lan', 'listen on every interface, in the clear, rather than on this machine alone')
    .action(async (opts: { lan?: boolean }) => {
      const path = defaultConfigPath()
      writeSetting(path, 'surfaces.web.enabled', true)
      if (opts.lan === true) writeSetting(path, 'surfaces.web.bind', 'lan')
      const said = await look()
      io.out(said.bind === 'lan' ? 'on, listening on the network' : 'on, on this machine alone')
      if (said.bind === 'lan') io.out(LAN)
      io.out(await takesEffect())
    })

  web
    .command('off')
    .description('Stop serving it, and disconnect every device')
    .action(async () => {
      // **Two acts, one word**, because "off" that leaves credentials behind is
      // not off: a setting somebody turns back on next week would otherwise
      // let every phone that was ever paired straight back in.
      writeSetting(defaultConfigPath(), 'surfaces.web.enabled', false)
      const gone = await revokeAll(tadeHome(), new Date())
      io.out('off')
      io.out(
        gone.length === 0
          ? 'no device was paired'
          : `${gone.length} device(s) disconnected — their credentials are no longer sessions`,
      )
      // **Off is not erased, and the difference is worth the line.** A device
      // that installed the shell holds it until it next reaches this machine,
      // and then a worker takes it off. Said here rather than left for
      // somebody to discover a page still opening on a phone they revoked.
      if (gone.length > 0) io.out(INSTALLED_IS_NOT_REVOCABLE)
      io.out(await takesEffect())
    })

  web
    .command('pair')
    .description('Print a code for a device to scan. Needs an open window')
    .action(async () => {
      const home = tadeHome()
      const open = await heldBy(home)
      if (open === null) {
        // It is the window that asks you whether to let a device in, and that
        // keypress is the whole authorisation. Without one there is nobody to
        // ask, so there is nothing a ticket could be worth.
        io.err('no window is open on this home, and it is the window that lets a device in')
        io.err('open Tade, then press the away view’s own key, or run `tade web pair` again')
        setExit(Exit.error)
        return
      }
      const said = await look()
      if (!said.enabled) {
        io.err('the away view is off: `tade web on` first')
        setExit(Exit.error)
        return
      }
      // **The code is the window's to mint, and this cannot mint one.** A
      // ticket lives in the memory of the process whose server has to claim
      // it; one made here would be claimed by nothing. There is no channel
      // from here into the window either — the `ToolHost` is a Unix socket for
      // the window's own child agents and must never become this — so what
      // `tade web pair` can honestly do is point at the panel that mints one.
      io.out(`Tade is open (pid ${open}). Open its AWAY VIEW panel for a code to scan.`)
      io.out('It will ask you at the machine before letting the device in.')
      const url = said.urls[0]
      if (url !== undefined) io.out(`The page is at ${url}`)
    })

  web
    .command('devices')
    .description('Every paired device: what it may read, and when it was paired')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const read = await readDevices(tadeHome())
      const live = read.devices.filter((one) => one.revoked === null)
      if (opts.json) {
        io.out(JSON.stringify(live.map(asJson), null, 2))
        return
      }
      if (read.skipped > 0) {
        io.err(`${read.skipped} line(s) of ${devicesPath(tadeHome())} could not be read`)
      }
      if (live.length === 0) {
        io.out('no device is paired')
        return
      }
      const width = Math.max(...live.map((one) => (one.label || 'a device').length))
      for (const one of live) {
        const reads = readsOf(reachOf(one))
        io.out(
          `${(one.label || 'a device').padEnd(width)}  ${one.id}  paired ${when(one.pairedAt)}  ${
            reads.length === 0 ? 'names and counts' : reads.join(', ')
          }`,
        )
      }
      io.out(AGENTS)
    })

  web
    .command('revoke [device]')
    .description('Disconnect one device, or every one. Needs no network')
    .option('--all', 'every device')
    .action(async (device: string | undefined, opts: { all?: boolean }) => {
      const home = tadeHome()
      if (opts.all === true) {
        const gone = await revokeAll(home, new Date())
        io.out(gone.length === 0 ? 'no device was paired' : `${gone.length} device(s) disconnected`)
        return
      }
      if (device === undefined) {
        io.err('name a device, or pass --all')
        setExit(Exit.invalidInput)
        return
      }
      const read = await readDevices(home)
      const found = read.devices.find((one) => one.id === device && one.revoked === null)
      if (found === undefined) {
        io.err(`no paired device called ${device}`)
        setExit(Exit.invalidInput)
        return
      }
      await appendDevice(home, {
        kind: 'revoked',
        device: found.id,
        at: new Date().toISOString(),
        why: 'revoked at the machine',
      })
      io.out(`${found.label || found.id} disconnected`)
      io.out(`if it installed this page, ${INSTALLED_IS_NOT_REVOCABLE_SHORT}`)
      // Said rather than assumed: a window holding a stream for that device
      // closes it on its next beat, which is two seconds away — and with no
      // window open there is no stream to close, because there is no listener.
      io.out('its credential is no longer a session, and any open page stops within a beat')
    })
}

/** Everything `status` says, as one value, so `--json` and the lines agree. */
export interface Looked {
  enabled: boolean
  bind: 'loopback' | 'lan'
  port: number
  trustedHosts: readonly string[]
  /** Whether a device may install the shell, which is a fact about this file. */
  installs: boolean
  /** Whether an installed device may keep a few counts on its own disk. */
  keepsView: boolean
  /** Whether an installed device may be sent a notification. */
  notifies: boolean
  /** Whether a window is open on this home, which is what makes it answer. */
  windowOpen: boolean
  /**
   * Whether `config.yaml` could be read at all.
   *
   * `false` means every setting below is this command's **default** and not
   * what is set — which has to be said, because "off" read off a file nothing
   * could parse is a guess, and a person whose config is broken would
   * otherwise be told the away view is off while a window serves it.
   */
  read: boolean
  /** Where a phone would go. Empty where nothing could reach it. */
  urls: readonly string[]
  devices: ReturnType<typeof asJson>[]
  /** Lines of the device list that could not be read. */
  skipped: number
}

async function look(): Promise<Looked> {
  const home = tadeHome()
  const loaded = await loadConfig(defaultConfigPath())
  // A config that will not load is not a reason to refuse to answer — the
  // device list is still readable and `revoke` still works — but it **is** a
  // reason to say so rather than print the defaults as though they were what
  // is set. `read: false` is carried all the way to the lines and to `--json`.
  const surface = loaded.ok
    ? surfaceOf(loaded.config.surfaces.web)
    : {
        enabled: false,
        bind: 'loopback' as const,
        port: 7654,
        trustedHosts: [],
        installing: false,
        keepsView: false,
        pushing: false,
      }
  const read = await readDevices(home)
  const trusted = surface.trustedHosts.map((host) => `https://${host}/`)
  return {
    enabled: surface.enabled,
    bind: surface.bind,
    port: surface.port,
    trustedHosts: surface.trustedHosts,
    installs: surface.installing,
    keepsView: surface.keepsView,
    notifies: surface.pushing,
    windowOpen: (await heldBy(home)) !== null,
    read: loaded.ok,
    urls: surface.enabled
      ? [...trusted, ...(surface.bind === 'loopback' ? [`http://localhost:${surface.port}/`] : [])]
      : [],
    devices: read.devices.filter((one) => one.revoked === null).map(asJson),
    skipped: read.skipped,
  }
}

function lines(said: Looked): string[] {
  const out: string[] = []
  if (!said.read) {
    // First, and before anything that looks like an answer: everything under
    // this is a default rather than a reading.
    out.push(`${defaultConfigPath()} could not be read, so this cannot say what is set`)
    out.push('`tade config --check` says what is wrong with it')
  }
  if (!said.enabled) {
    out.push('off — nothing is listening')
    out.push('`tade web on` serves it on this machine alone')
    return out
  }
  out.push(said.bind === 'lan' ? 'on, listening on the network' : 'on, on this machine alone')
  out.push(`port ${said.port}`)
  for (const url of said.urls) out.push(url)
  // **Said, not papered over.** With no window open nothing is listening,
  // whatever the setting says, and a phone that taps its bookmark gets the
  // browser's own connection error — which it cannot tell from a sleeping
  // laptop. Saying it here is the difference between a setting somebody
  // believes and one they understand.
  out.push(
    said.windowOpen
      ? 'a window is open, so it is answering now'
      : 'no window is open, so nothing is answering: the away view lives in the window and dies with it',
  )
  if (said.bind === 'lan') out.push(LAN)
  if (said.installs) {
    // **Said where somebody can see it, and with what it needs.** A phone that
    // cannot install this gets no error it can act on — the browser simply
    // does not offer it — so the one place that can explain is here and the
    // Settings row.
    out.push(
      said.keepsView
        ? 'a device may install it and keep a few counts it can open with nothing to ask'
        : 'a device may install it; it opens with nothing until it can reach this machine',
    )
    out.push(OFFLINE_NEEDS_HTTPS)
  }
  if (said.notifies) {
    // **Said here because the two halves are in two places.** This machine
    // being willing is one of them; the other is a permission on a phone that
    // nothing here can press or read back, so a person who turned the setting
    // on and heard nothing has no way to tell *not granted* from *broken*
    // except by being told which half this command can see.
    out.push('a device that allowed notifications is told when work wants you')
    out.push(PUSH_NEEDS_A_GESTURE)
    out.push(PUSH_IS_WHILE_OPEN)
  }
  out.push(
    said.devices.length === 0
      ? 'no device is paired'
      : `${said.devices.length} device(s) paired — \`tade web devices\``,
  )
  if (said.skipped > 0) out.push(`${said.skipped} line(s) of the device list could not be read`)
  return out
}

function asJson(device: Device) {
  return {
    device: device.id,
    // The label is the person's own words about their own phone, carried
    // verbatim because it is theirs. It is never put in a path or a log line.
    label: device.label,
    pairedAt: new Date(device.pairedAt).toISOString(),
    until: new Date(device.until).toISOString(),
    scopes: device.scopes,
    reads: readsOf(reachOf(device)),
    projects: device.projects,
  }
}

/** Whether a setting written now is a listener now. It is not. */
async function takesEffect(): Promise<string> {
  return (await heldBy(tadeHome())) === null
    ? 'it takes effect the next time Tade starts'
    : 'a window is open on this home: it takes effect the next time Tade starts'
}

/**
 * The two sentences the terminal says, which are the same two the window says.
 *
 * One spelling of each, in the domain (`@tade/core`'s `away.ts`), carried by
 * the Settings row and by the away panel as well — so the terminal and the
 * window cannot say two different things about the same wifi or the same file.
 */
const LAN = LAN_IS_PLAINTEXT
const AGENTS = DEVICES_AND_AGENTS

/**
 * When something happened, in the plain words a terminal gets.
 *
 * Days and hours, because a paired device is a thing you did last week.
 */
function when(at: number): string {
  const ms = Date.now() - at
  if (!Number.isFinite(ms) || ms < 0) return 'at an unknown time'
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `${days}d ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 1) return `${hours}h ago`
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`
}
