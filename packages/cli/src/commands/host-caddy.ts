import { dirname } from 'node:path'
import {
  belowOldest,
  CADDY,
  CADDY_OLDEST,
  type CertificateLook,
  certificateSays,
  type DirSeen,
  type Health,
  outdatedSays,
  PUBLIC_IS_THE_INTERNET,
  publicDirCommand,
  publicDirProblem,
} from '@tade/core'

// `tade host caddy`: what puts the away view on a name of the person's own,
// behind Caddy on this box. The block alone on standard output, so
// `tade host caddy | sudo tee -a /etc/caddy/Caddyfile` is the whole of adding
// it; everything else — the one root line for the socket's directory, the
// records the name needs, the switch — on standard error, beside it.
//
// It writes nothing, runs nothing and asks nobody anything unless `--check` is
// passed: the directory needs root, the Caddyfile is Caddy's, and the records
// are at the registrar. What Tade can do is say each exactly.

/** What is said beside the block, in the order it is done. */
export function caddySaid(opts: {
  name: string
  /** `surfaces.web.public` as the config has it now. */
  configured: string
  user: string
  socket: string
  dir: DirSeen | null
  uid: number
}): string[] {
  const dir = dirname(opts.socket)
  const problem = publicDirProblem(opts.dir, opts.uid, dir)
  return [
    '',
    PUBLIC_IS_THE_INTERNET,
    '',
    `1. Once, as root, the directory only you and Caddy can open, made again at every boot:`,
    `   ${publicDirCommand(opts.user, dir)}`,
    problem === null
      ? `   ${dir} is there, and right.`
      : `   now: ${problem.replace(/: `tade host caddy`.*$/, '')}`,
    `2. Caddy ${CADDY_OLDEST} or newer (\`caddy version\`) — ${CADDY.install?.aptTooOld} — then the block above in`,
    `   /etc/caddy/Caddyfile, and \`sudo systemctl reload caddy\`.`,
    `3. An A record for ${opts.name} pointing at this machine — and AAAA only if IPv6 answers on 443,`,
    `   because Let's Encrypt tries it first; once there is a certificate, a CAA record. \`tade host`,
    `   domain ${opts.name}\` looks at each and says exactly what to add.`,
    opts.configured === opts.name
      ? `4. surfaces.web.public is ${opts.name}: with the away view on, Tade listens for Caddy at ${opts.socket}.`
      : `4. Set surfaces.web.public to ${opts.name} (Settings › Away view › Public name), and turn the away view on.`,
    '',
    '`tade host caddy --check` looks at all of it from here.',
  ]
}

/** What `--check` needs, so a test can hand its own. */
export interface Looking {
  name: string
  socket: string
  uid: number
  dir: DirSeen | null
  /** Whether something answers on the socket. */
  answering: (socket: string) => Promise<boolean>
  look: (name: string) => Promise<CertificateLook>
  /** What `caddy version` said here: its version, or null where there is no caddy to ask. */
  caddy: () => Promise<{ version: string | null } | null>
  /** The kept Updates answer: its clause for a newer Tade, or null where nothing has asked. Asks nobody. */
  newer: () => Promise<{ newer: string | null } | null>
  now: number
}

/**
 * The health look, from this box: the directory, whether Tade is listening in
 * it, the certificate the name answers with, and whether Tade is behind. Loud
 * ones are what nobody may miss, and the command's exit says whether there was
 * one.
 */
export async function lookAtPublic(at: Looking): Promise<Health[]> {
  const out: Health[] = []
  const problem = publicDirProblem(at.dir, at.uid, dirname(at.socket))
  if (problem !== null) out.push({ said: problem, loud: true })
  else if (await at.answering(at.socket)) {
    out.push({ said: `Tade is listening for Caddy at ${at.socket}`, loud: false })
  } else {
    out.push({
      said: `nothing listens at ${at.socket}: Tade listens there while its window is open with the away view on and surfaces.web.public set`,
      loud: true,
    })
  }
  out.push(caddySays(await at.caddy()))
  out.push(certificateSays(at.name, await at.look(at.name), at.now))
  const kept = await at.newer()
  if (kept === null) {
    out.push({
      said: 'whether Tade is behind cannot be told: nothing here has asked — `tade update --check` asks',
      loud: false,
    })
  } else {
    const behind = outdatedSays(at.name, kept.newer)
    out.push(behind ?? { said: 'Tade is not behind, as of the last update check', loud: false })
  }
  return out
}

/** Caddy here, said against the oldest the block works with. */
export function caddySays(seen: { version: string | null } | null): Health {
  if (seen === null) {
    return { said: `no caddy here: it needs installing, ${CADDY_OLDEST} or newer`, loud: true }
  }
  if (seen.version === null) {
    return { said: `caddy is here, and what version it is cannot be told`, loud: false }
  }
  if (belowOldest(seen.version, CADDY_OLDEST)) {
    return {
      said: `caddy ${seen.version} is too old for the block, which needs ${CADDY_OLDEST}: ${CADDY.install?.aptTooOld}`,
      loud: true,
    }
  }
  return { said: `caddy ${seen.version}`, loud: false }
}
