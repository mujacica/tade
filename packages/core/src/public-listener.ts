import type { RequiredProgram } from './programs.ts'
import { shellWord } from './readiness.ts'

// The away view on a name of the person's own, behind Caddy (`surfaces.web.public`).
//
// Pure, and the one place each of these is said, so the listener, `tade host
// caddy` and the window agree: where the socket is, what its directory must be
// before anything listens in it, the site block that points Caddy at it, and
// what the health look comes to.
//
// **Why a Unix socket and not a port on loopback.** A loopback port is open to
// every process on the box, and so is the address a proxy writes into a PROXY
// header on it; a socket in a directory only Caddy's group can open is open to
// Caddy. The address it carries moves a rate limit and a line in the journal,
// never a permission — that is decided by which listener accepted the socket
// (`thisMachine`), and on this one the answer is always *public*.
//
// **Why `/run`.** Caddy's own package runs it as `caddy` with `PrivateTmp`, so
// a socket under `/tmp` is one it cannot see, and a home directory is `0700` or
// `0750` on Debian and Ubuntu, which it cannot walk into. `/run` is neither, and
// is emptied at every boot — which is why the line that makes the directory is
// a `tmpfiles.d` line rather than a `mkdir`.

/** Where the socket's directory is. Root makes it, once (`publicDirCommand`). */
export const PUBLIC_DIR = '/run/tade'

/** The socket Caddy connects to, in `dir`. One per machine: one Tade per machine. */
export function publicSocket(dir: string = PUBLIC_DIR): string {
  return `${dir}/away.sock`
}

/** The group Caddy runs as when installed from its own package. */
export const CADDY_GROUP = 'caddy'

/**
 * Whether a public name is a name: labels of letters, digits and hyphens, at
 * least two of them, and the last not a number — so no scheme, port, path or
 * address can get into a site block or a certificate request.
 */
export function publicName(name: string): boolean {
  if (name.length > 253) return false
  const labels = name.split('.')
  if (labels.length < 2) return false
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
  if (!labels.every((one) => label.test(one))) return false
  return !/^\d+$/.test(labels.at(-1) ?? '')
}

/** The socket's directory, as `stat` saw it. */
export interface DirSeen {
  directory: boolean
  uid: number
  mode: number
}

/**
 * What is wrong with the socket's directory, in words that end in the fix — or
 * null when it is what `publicDirCommand` makes: this user's, Caddy's group
 * able to walk into it and nobody else, and setgid so the socket is Caddy's
 * group's too.
 *
 * **Refused rather than repaired.** The fixes all need root, and a listener
 * that loosened a directory to come up would be deciding who may connect to it.
 */
export function publicDirProblem(
  seen: DirSeen | null,
  uid: number,
  dir: string = PUBLIC_DIR,
): string | null {
  const fix = '`tade host caddy` prints the line that makes it'
  if (seen === null) return `${dir} is not there, so nothing listens for Caddy: ${fix}`
  if (!seen.directory) return `${dir} is not a directory, so nothing listens for Caddy: ${fix}`
  if (seen.uid !== uid) return `${dir} is not this user’s, so Tade cannot listen in it: ${fix}`
  if ((seen.mode & 0o007) !== 0) {
    return `${dir} is open to every user on this machine, and only Caddy’s group should reach the socket: ${fix}`
  }
  if ((seen.mode & 0o010) === 0) {
    return `${dir} is closed to its group, so Caddy could not reach the socket: ${fix}`
  }
  if ((seen.mode & 0o2000) === 0) {
    return `${dir} has no setgid bit, so the socket would not be Caddy’s group’s: ${fix}`
  }
  return null
}

/**
 * The one line, run as root once, that makes the directory now and at every
 * boot: this user's, Caddy's group's, `2750`.
 */
export function publicDirCommand(user: string, dir: string = PUBLIC_DIR): string {
  const conf = '/etc/tmpfiles.d/tade.conf'
  return (
    `printf 'd ${dir} 2750 %s ${CADDY_GROUP} -\\n' ${shellWord(user)} | sudo tee ${conf} >/dev/null` +
    ` && sudo systemd-tmpfiles --create ${conf}`
  )
}

/**
 * The oldest Caddy the site block works with: `proxy_protocol` in
 * `reverse_proxy`'s http transport is 2.7's, and 2.6 refuses the whole
 * Caddyfile with "unrecognized subdirective proxy_protocol". Debian 12's and
 * Ubuntu 24.04's own `caddy` package is 2.6.2.
 */
export const CADDY_OLDEST = '2.7'

/** Caddy, in front of a public name: declared here, folded in under Tade, in use once a name is set. */
export const CADDY: RequiredProgram = {
  command: 'caddy',
  title: 'Caddy',
  why: 'putting the away view on a public name of yours, with its certificate (`tade host caddy`)',
  versionArgs: ['version'],
  optional: true,
  oldest: CADDY_OLDEST,
  install: {
    brew: 'caddy',
    apt: 'caddy',
    aptTooOld:
      'Debian’s and Ubuntu’s own caddy is 2.6, which refuses the block — Caddy’s own apt repository has a current one: caddyserver.com/docs/install',
    dnf: 'caddy',
  },
}

export const PUBLIC_PROGRAMS: readonly RequiredProgram[] = [CADDY]

/**
 * The site block for `name`, as it goes into `/etc/caddy/Caddyfile`.
 *
 * Name-bound, never a catch-all, so a request for any other name reaches
 * nothing. `Host` passes through as it came — Caddy's default, and the one Tade
 * needs, because it refuses a request whose `Host` is not this name. The PROXY
 * header is how each phone's address reaches Tade, for a pairing limit per
 * phone rather than one for the internet: Caddy 2.11.7 sends it over a Unix
 * socket upstream and keeps one upstream connection per client address, which
 * is what makes the address right for every request on it.
 */
export function caddySite(name: string, socket: string = publicSocket()): string {
  return [
    `${name} {`,
    `\treverse_proxy unix/${socket} {`,
    '\t\ttransport http {',
    '\t\t\tproxy_protocol v2',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n')
}

/** What a TLS look at the public name saw of its certificate. */
export interface CertificateSeen {
  /** Milliseconds, as the certificate says. */
  validFrom: number
  validTo: number
  /** Who issued it, as its organisation or common name. */
  issuer: string
  /** Whether this machine's trust store verifies it for the name. */
  authorized: boolean
  /** Why it does not, in TLS's own words, where it does not. */
  error: string | null
}

/** A look at the certificate: what was seen, or why nothing could be. */
export type CertificateLook = { at: number; seen: CertificateSeen } | { at: number; cannot: string }

/** One line of the health look, and whether it is the kind nobody may miss. */
export interface Health {
  said: string
  loud: boolean
}

const DAY = 86_400_000

/**
 * What the certificate look comes to, for `name`.
 *
 * **Loud past a sixth of its life left.** Caddy renews at a third, so a sixth
 * left is a renewal that has been failing for weeks — and with Let's Encrypt's
 * lifetimes shrinking from ninety days to forty-five, a fixed number of days
 * would be late for one and early for the other. Since expiry e-mails ended in
 * 2025, nothing else says so.
 */
export function certificateSays(name: string, look: CertificateLook, now: number): Health {
  if ('cannot' in look) {
    return { said: `could not look at https://${name}: ${look.cannot}`, loud: true }
  }
  const { seen } = look
  if (!seen.authorized) {
    return {
      said: `the certificate for ${name} does not verify: ${seen.error ?? 'no reason given'}`,
      loud: true,
    }
  }
  const left = seen.validTo - now
  if (left <= 0) {
    const ago = Math.floor(-left / DAY)
    return {
      said: `the certificate for ${name} ran out ${ago === 0 ? 'today' : `${days(ago)} ago`}`,
      loud: true,
    }
  }
  const life = seen.validTo - seen.validFrom
  const late = left < life / 6
  const until = new Date(seen.validTo).toISOString().slice(0, 10)
  return {
    said:
      `certificate: ${days(Math.floor(left / DAY))} left, until ${until}, from ${seen.issuer}` +
      (late ? ' — Caddy renews at a third of its life, so renewing has been failing' : ''),
    loud: late,
  }
}

/**
 * What it is to be behind with the internet able to reach this machine, or
 * null when Tade is not behind. `newer` is the Updates look's own clause.
 */
export function outdatedSays(name: string, newer: string | null): Health | null {
  if (newer === null) return null
  return {
    said: `this Tade is out of date (${newer}) and answers the internet as ${name}: \`tade update\` moves it forward`,
    loud: true,
  }
}

function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`
}
