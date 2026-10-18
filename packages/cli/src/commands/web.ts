import {
  alwaysOpenHere,
  CONNECT_SOURCES,
  CONNECT_TITLES,
  DEVICES_AND_AGENTS,
  defaultConfigPath,
  INSTALLED_IS_NOT_REVOCABLE,
  INSTALLED_IS_NOT_REVOCABLE_SHORT,
  LAN_IS_PLAINTEXT,
  loadConfig,
  OFFLINE_NEEDS_HTTPS,
  OWNER_IS_YOUR_SSH_KEY,
  PUSH_IS_WHILE_OPEN,
  PUSH_NEEDS_A_GESTURE,
  printable,
  publicSocket,
  tadeHome,
} from '@tade/core'
import {
  appendDevice,
  blocksFor,
  COOKIE,
  codeFor,
  connectWhere,
  type Device,
  devicesPath,
  GRANTS,
  mintOwner,
  PENDING_MS,
  pairingUrl,
  reachOf,
  readDevices,
  readsOf,
  revokeAll,
  SCOPES,
  type Surface,
  surfaceOf,
  writeCode,
} from '@tade/web'
import { heldBy } from '@tade/workbench/lock'
import { keptByServiceHere } from '@tade/workbench/machine'
import type { Command } from 'commander'
import { writeFromShell } from '../config-write.ts'
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
// listener lives in the window, so with none open it is *next time Tade
// starts*; a window open on this home takes the change the next time it looks
// (`Settings.fold`) and brings its listener up or down as its own switch does.
//
// **`pair` writes a code, and needs no window to.** It used to only point at
// the panel, because a ticket lived in the window's memory and the person at
// its screen was the yes. On a box with no screen the shell is the machine:
// the code is written into the device list as a digest, the link printed (as a
// QR where a phone could follow it), and the listener claims it — running the
// command was the yes (`@tade/web`'s `pending.ts` has the argument). `--owner`
// mints an owner device the same way (`owner.ts`). With no window open both
// say that nothing answers until one is.
//
// **`connect` is where the guided pages that connect a source are**, which on
// a box with no screen nothing else on it said: this machine's own door, the
// one place they answer, and the SSH forward from anywhere else. It prints and
// opens nothing — a browser on a server is nobody's — and reads the config and
// the lock, as `status` does.

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
      await writeFromShell(
        path,
        [
          { key: 'surfaces.web.enabled', value: true },
          ...(opts.lan === true ? [{ key: 'surfaces.web.bind', value: 'lan' }] : []),
        ],
        io.err,
      )
      const said = await look()
      io.out(listening(said))
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
      await writeFromShell(
        defaultConfigPath(),
        [{ key: 'surfaces.web.enabled', value: false }],
        io.err,
      )
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
    .description(
      'Let a device in from this shell: a one-time code to scan, or with --owner a session for the machine you reached this one from over SSH',
    )
    .option('--owner', 'an owner device: a session bound to this machine, printed once')
    .option('--read-only', 'it may read everything and change nothing')
    .option('--label <name>', 'what to call it in the device list')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: { owner?: boolean; readOnly?: boolean; label?: string; json?: boolean }) => {
        const label = opts.label ?? ''
        if (label.length > 120) {
          io.err('a label is at most 120 characters')
          setExit(Exit.invalidInput)
          return
        }
        const path = defaultConfigPath()
        const loaded = await loadConfig(path)
        if (!loaded.ok) {
          // Never a code minted against defaults: the port and the name a link
          // carries are the config's, and a guessed one goes nowhere.
          io.err(`${path} could not be read, so this cannot say where a device would go`)
          io.err('`tade config --check` says what is wrong with it')
          setExit(Exit.error)
          return
        }
        const surface = surfaceOf(loaded.config.surfaces.web)
        if (!surface.enabled) {
          io.err('the away view is off: `tade web on` first')
          setExit(Exit.error)
          return
        }
        const window = (await heldBy(tadeHome())) !== null
        const pairing = { label, json: opts.json === true, window }
        if (opts.owner === true) await pairOwner(io, setExit, surface, pairing)
        else await pairCode(io, setExit, surface, { ...pairing, readOnly: opts.readOnly === true })
      },
    )

  web
    .command('devices')
    .description(
      'Every paired device, owners marked, and every code nobody has used yet: what each may read, and when',
    )
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
      const codes = read.pending.filter((code) => code.until > Date.now())
      if (live.length === 0) io.out('no device is paired')
      // A device names itself when it pairs, so its label is a stranger's
      // words until somebody renames it: printed as text.
      const label = (one: (typeof live)[number]) => printable(one.label || 'a device')
      const width = Math.max(0, ...live.map((one) => label(one).length))
      for (const one of live) {
        const reads = readsOf(reachOf(one))
        io.out(
          `${label(one).padEnd(width)}  ${one.id}  paired ${when(one.pairedAt)}  ${
            // An owner reads everything and its reach is the keyboard's, so
            // the word that matters is that one, said first.
            one.owner
              ? 'owner, over SSH'
              : reads.length === 0
                ? 'names and counts'
                : reads.join(', ')
          }${
            // Whether it can still act from a public name is its passkey, and
            // when it last used it is the question about a phone gone missing.
            one.passkey === null ? '' : `  passkey, used ${when(one.passkey.proved)}`
          }`,
        )
      }
      // **Every way in there is, not only the ones used**: a code nobody has
      // claimed yet is a credential too, and `revoke` takes it by this id.
      for (const code of codes) {
        io.out(`a code from the terminal  ${code.id}  unclaimed, ${left(code.until)}`)
      }
      if (live.length > 0 || codes.length > 0) io.out(AGENTS)
    })

  web
    .command('revoke [device]')
    .description('Disconnect one device or an unused code, or every one. Needs no network')
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
      const code = read.pending.find((one) => one.id === device)
      if (found === undefined && code !== undefined) {
        // A code nobody claimed: one `revoked` line, and the listener's claim
        // finds nothing — the window need not be open to hear it.
        await appendDevice(home, {
          kind: 'revoked',
          device: code.id,
          at: new Date().toISOString(),
          why: 'revoked at the machine',
        })
        io.out('that code can no longer be used')
        return
      }
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
      io.out(`${printable(found.label || found.id)} disconnected`)
      io.out(`if it installed this page, ${INSTALLED_IS_NOT_REVOCABLE_SHORT}`)
      // Said rather than assumed: a window holding a stream for that device
      // closes it on its next beat, which is two seconds away — and with no
      // window open there is no stream to close, because there is no listener.
      io.out('its credential is no longer a session, and any open page stops within a beat')
    })

  web
    .command('connect')
    .description(
      `Where the guided pages that connect ${CONNECT_SOURCES.map((one) => CONNECT_TITLES[one]).join(', ')} answer: printed, to open here or through ssh -L`,
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const path = defaultConfigPath()
      const loaded = await loadConfig(path)
      if (!loaded.ok) {
        // Never a port guessed from the defaults: a link to the wrong one is a
        // page that does not open, with nothing to say why.
        io.err(`${path} could not be read, so this cannot say where they answer`)
        io.err('`tade config --check` says what is wrong with it')
        setExit(Exit.error)
        return
      }
      // Only this machine's own door (`connect-where.ts`): the pages are never
      // on a public name, and an off or `lan` surface is a reason, not a link.
      const where = connectWhere(surfaceOf(loaded.config.surfaces.web))
      const window = (await heldBy(tadeHome())) !== null
      if (opts.json) {
        io.out(JSON.stringify({ ...where, answering: where.url !== null && window }, null, 2))
      } else if (where.url === null) {
        io.err(where.why)
      } else {
        io.out(where.url)
        io.out(`open it ${where.how}`)
      }
      if (where.url === null) setExit(Exit.error)
      else if (!window) io.err(NOTHING_ANSWERS)
    })
}

/** Everything `status` says, as one value, so `--json` and the lines agree. */
export interface Looked {
  enabled: boolean
  bind: 'loopback' | 'lan'
  port: number
  trustedHosts: readonly string[]
  /** The name the internet reaches it by through Caddy, or null. */
  publicName: string | null
  /** Whether a device may install the shell, which is a fact about this file. */
  installs: boolean
  /** Whether an installed device may keep a few counts on its own disk. */
  keepsView: boolean
  /** Whether an installed device may be sent a notification. */
  notifies: boolean
  /** Whether a window is open on this home, which is what makes it answer. */
  windowOpen: boolean
  /**
   * What keeps that window open, where a service manager does — linger on
   * and the unit `tade host service` wrote active (`keptByServiceHere`) — or
   * null. The window knows it of itself; a shell over SSH has to ask.
   */
  keptBy: 'systemd' | null
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
  /** Codes `tade web pair` wrote that nobody has used, and are still good. */
  codes: { device: string; host: string; until: string }[]
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
        publicName: null,
        installing: false,
        keepsView: false,
        pushing: false,
      }
  const read = await readDevices(home)
  const trusted = surface.trustedHosts.map((host) => `https://${host}/`)
  const windowOpen = (await heldBy(home)) !== null
  return {
    enabled: surface.enabled,
    bind: surface.bind,
    port: surface.port,
    trustedHosts: surface.trustedHosts,
    publicName: surface.publicName,
    installs: surface.installing,
    keepsView: surface.keepsView,
    notifies: surface.pushing,
    windowOpen,
    // Asked only of an open window: a unit running while none holds this
    // home is restarting it, or keeping some other home's.
    keptBy: windowOpen ? await keptByServiceHere() : null,
    read: loaded.ok,
    urls: surface.enabled
      ? [...trusted, ...(surface.bind === 'loopback' ? [`http://localhost:${surface.port}/`] : [])]
      : [],
    devices: read.devices.filter((one) => one.revoked === null).map(asJson),
    codes: read.pending
      .filter((code) => code.until > Date.now())
      .map((code) => ({
        device: code.id,
        host: code.host,
        until: new Date(code.until).toISOString(),
      })),
    skipped: read.skipped,
  }
}

/**
 * Where it listens, as the first line says it.
 *
 * "Alone" only where it is: a public name is a second listener, Caddy's, and
 * a box with one is on the internet as well as on itself.
 */
function listening(said: Pick<Looked, 'bind' | 'publicName'>): string {
  const here = said.bind === 'lan' ? 'on, listening on the network' : 'on, on this machine'
  if (said.publicName !== null) return `${here} and on the internet as ${said.publicName}`
  return said.bind === 'lan' ? here : `${here} alone`
}

/** What installing needs, said where a public name already gives it. */
function installsOn(name: string): string {
  return (
    `https://${name}/ is a secure origin, so a device can install it there — and pairs there, ` +
    'because a session is bound to the exact host it was paired on and nothing is carried across.'
  )
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
  out.push(listening(said))
  out.push(`port ${said.port}`)
  for (const url of said.urls) out.push(url)
  if (said.publicName !== null) {
    out.push(
      `${said.publicName} comes in through Caddy at ${publicSocket()} — \`tade host caddy --check\` looks at it`,
    )
  }
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
    // A public name is already the https origin `OFFLINE_NEEDS_HTTPS` sends
    // somebody to find, so there it says where to install rather than how
    // to get somewhere one could.
    out.push(said.publicName === null ? OFFLINE_NEEDS_HTTPS : installsOn(said.publicName))
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
    // What Settings says after it on that machine, where that window always is.
    if (said.keptBy !== null) out.push(alwaysOpenHere(said.keptBy))
  }
  out.push(
    said.devices.length === 0
      ? 'no device is paired'
      : `${said.devices.length} device(s) paired — \`tade web devices\``,
  )
  if (said.codes.length > 0)
    out.push(`${said.codes.length} code(s) from \`tade web pair\` not used yet`)
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
    owner: device.owner,
    // Its passkey's dates and whether it syncs — never its id or its key,
    // which are nobody's business in a terminal's scrollback.
    passkey:
      device.passkey === null
        ? null
        : {
            made: new Date(device.passkey.at).toISOString(),
            used: new Date(device.passkey.proved).toISOString(),
            synced: device.passkey.synced,
          },
  }
}

/** How long a code has left, in the plain words a terminal gets. */
function left(until: number): string {
  const minutes = Math.ceil((until - Date.now()) / 60_000)
  return minutes <= 1 ? 'under a minute left' : `${minutes} minutes left`
}

/** What both kinds of pairing were asked for. */
interface Pairing {
  label: string
  json: boolean
  /** Whether a window is open on this home, which is what answers a link. */
  window: boolean
}

/**
 * A one-time code, written down for the listener to claim (`@tade/web`'s
 * `pending.ts`, which has the argument): running this is the yes the window's
 * panel would have asked for, so nobody is asked again when it is used.
 *
 * The QR only where a phone could follow it — an `https` name or a LAN
 * address — because a code for `localhost` scans perfectly and opens the
 * phone's own nothing; that link is for this machine, or a browser at the far
 * end of an SSH forward.
 */
async function pairCode(
  io: Io,
  setExit: (code: number) => void,
  surface: Surface,
  pairing: Pairing & { readOnly: boolean },
): Promise<void> {
  const base = pairingUrl(surface)
  if (base === null) {
    io.err('no network: nothing could reach this machine, so a code would go nowhere')
    setExit(Exit.error)
    return
  }
  const host = new URL(base).host
  const written = await writeCode(
    tadeHome(),
    {
      host,
      label: pairing.label,
      // Everything, opt-out, as the window's own yes is (`EVERYTHING`); the
      // origin's ceiling still holds at the claim (`scopesOn`).
      scopes: pairing.readOnly ? ['read'] : [...SCOPES],
      projects: null,
      granted: [...GRANTS],
    },
    Date.now(),
  )
  const url = `${base}#t=${written.secret}`
  const until = new Date(written.until).toISOString()
  if (pairing.json) {
    io.out(
      JSON.stringify(
        { device: written.device, url, host, until, answering: pairing.window },
        null,
        2,
      ),
    )
    if (!pairing.window) io.err(NOTHING_ANSWERS)
    return
  }
  const phone = base.startsWith('https://') || surface.bind === 'lan'
  const code = phone ? codeFor(url) : null
  if (code !== null) for (const line of blocksFor(code)) io.out(line)
  io.out(url)
  const minutes = Math.round(PENDING_MS / 60_000)
  io.out(
    phone
      ? `scan it with a phone’s camera, or open the link — once, within ${minutes} minutes`
      : `open it on this machine, or in a browser through \`ssh -L ${surface.port}:localhost:${surface.port}\` — once, within ${minutes} minutes`,
  )
  io.out(
    pairing.readOnly
      ? 'it may read everything and change nothing'
      : 'full access: it may read and do whatever is turned on here, and the AWAY VIEW panel takes any of it back',
  )
  if (surface.bind === 'lan') io.out(LAN)
  io.out(`\`tade web revoke ${written.device}\` takes the code back before anybody uses it`)
  if (!pairing.window) io.err(NOTHING_ANSWERS)
}

/**
 * An owner device: a session minted here and printed once, for the Tade on
 * the machine you reached this one from (`@tade/web`'s `owner.ts`).
 *
 * Refused on a `lan` bind, where there is no loopback listener and so no door
 * an owner could ever be answered at — a credential that can never work is a
 * line in the device list for nothing.
 */
async function pairOwner(
  io: Io,
  setExit: (code: number) => void,
  surface: Surface,
  pairing: Pairing,
): Promise<void> {
  if (surface.bind === 'lan') {
    io.err('the away view listens on the network (`bind: lan`), where nothing is this machine,')
    io.err('so an owner session could never be used: `tade web on` without --lan first')
    setExit(Exit.error)
    return
  }
  const owner = await mintOwner(
    tadeHome(),
    {
      port: surface.port,
      label: pairing.label || 'owner',
      from: sshClient(process.env.SSH_CONNECTION),
    },
    Date.now(),
  )
  const said = {
    device: owner.device,
    // The whole pair, ready for a `Cookie:` header: over the loopback listener
    // it is plain HTTP, so the name is the one without `__Host-`.
    cookie: `${COOKIE}=${owner.cookie}`,
    csrf: owner.csrf,
    host: owner.host,
    until: new Date(owner.until).toISOString(),
  }
  if (pairing.json) io.out(JSON.stringify(said, null, 2))
  else {
    io.out(`owner device ${said.device}, for ${said.host}, until ${said.until.slice(0, 10)}`)
    io.out(`cookie: ${said.cookie}`)
    io.out(`csrf: ${said.csrf}`)
  }
  // On standard error, so `--json` is the credential alone: said every time,
  // because whoever runs this is the one deciding.
  io.err(OWNER_IS_YOUR_SSH_KEY)
  if (!surface.talking) {
    io.err(
      'talking to Tade from a device is off here, so its messages are refused until `surfaces.web.orchestrator` is on',
    )
  }
  if (!pairing.window) io.err(NOTHING_ANSWERS)
}

/** The address an SSH connection came from, or empty for a shell on this machine. */
function sshClient(connection: string | undefined): string {
  const first = connection?.trim().split(/\s+/)[0] ?? ''
  return /^[0-9a-fA-F.:]{2,64}$/.test(first) ? first : ''
}

/** Said wherever something was minted with no window to answer it. */
const NOTHING_ANSWERS =
  'no window is open on this home, so nothing answers until one is: the away view lives in the window'

/** When a setting written now is a listener: a window open on this home takes it, and none is. */
async function takesEffect(): Promise<string> {
  return (await heldBy(tadeHome())) === null
    ? 'it takes effect the next time Tade starts'
    : 'a window is open on this home, and takes it the next time it looks at the tasks'
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
