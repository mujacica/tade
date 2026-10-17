import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  copiesUnreadSays,
  type DomainLine,
  type DomainSeen,
  domainHead,
  domainSays,
  loadConfig,
  loopbackWrite,
  publicName,
  publicWrite,
  refusedName,
  tookBackSays,
  writeSetting,
} from '@tade/core'
import { heldIn, recordFromShell, type Unrecorded } from '../config-write.ts'
import type { Asker } from './host-service.ts'

// `tade host domain <name>`: the records a public name needs, looked at from
// the box, a line each — missing, wrong, not yet visible, or right — with the
// record to add or take away under it, exactly; then, on a press, the name
// written as the public name — or, declined, as a trusted hostname for a Caddy
// in front of the loopback listener, the one path that needs one.
//
// **The look is standard output and the asking is standard error**, the way
// `tade host caddy` and `tade host service` split them, so `tade host domain
// tade.example.com > records.txt` is the look alone. Nothing at the registrar
// is Tade's: every line ends in what to do there, and Tade does none of it.

/** Why `name` cannot be looked at as a public name, or null where it can. */
export function domainRefused(name: string): string | null {
  if (!publicName(name)) {
    return `${name} is not a host name: no scheme, port, path or address — tade.example.com`
  }
  return refusedName(name)
}

/** The look as the terminal prints it: the zone, then a line per record, with what to do at the registrar under it. */
export function domainPrinted(seen: DomainSeen): string[] {
  const out = [domainHead(seen)]
  for (const one of domainSays(seen)) {
    out.push(`${markOf(one)} ${one.said}`)
    if (one.add !== null) out.push(`    add     ${one.add}`)
    for (const gone of one.remove) out.push(`    remove  ${gone}`)
  }
  return out
}

/** `▲` for what stops a certificate or sends people elsewhere, `✓` for right, `·` for the rest. */
export function markOf(one: DomainLine): string {
  if (one.loud) return '▲'
  return one.state === 'right' ? '✓' : '·'
}

/** What `--json` prints: the look, and every line with its state. Nothing that changes between two runs of the same answers. */
export function domainJson(seen: DomainSeen): unknown {
  return { name: seen.name, zone: seen.zone, records: domainSays(seen) }
}

/** What `offerName` needs besides the name. */
export interface NameOffer {
  /** The config to write. */
  path: string
  /** A record stops a certificate or sends people elsewhere, so a bare Enter is no. */
  loud: boolean
  /** `--write`: the public name, without asking. */
  write: boolean
  /** There is a terminal to ask in. */
  asking: boolean
  /** What the journal says Tade copied into the trusted hostnames (`copiedHosts`); throws where it could not be read. */
  copies: () => Promise<readonly string[]>
  /** Whether a window has this home open, so a write applies when it next starts. */
  open: () => Promise<boolean>
}

/**
 * The name written on a press and never otherwise: it decides who reaches this
 * machine, so it is the person's to write. As the public name — or, where that
 * is not what they want, as a trusted hostname for a Caddy in front of the
 * loopback listener with no public socket, which is the one path that needs
 * one, said as that. False where a write failed, and why is said.
 */
export async function offerName(ask: Asker, name: string, offer: NameOffer): Promise<boolean> {
  const loaded = await loadConfig(offer.path)
  const web = loaded.ok ? loaded.config.surfaces.web : null
  ask.say('')
  if (web !== null && publicWrite(web, name, []) === null) {
    ask.say(`surfaces.web.public is ${name}.`)
    return true
  }
  if (!offer.write && !offer.asking) {
    ask.say(`\`tade host domain ${name} --write\` writes it as the public name.`)
    return true
  }
  const applies = async () =>
    (await offer.open())
      ? 'A window has this home open, and takes it the next time it looks at the tasks.'
      : 'It applies the next time Tade starts.'
  const question = `Write ${name} as surfaces.web.public?`
  if (offer.write || (await ask.confirm(question, !offer.loud))) {
    let copied: readonly string[] = []
    let unread = ''
    try {
      copied = await offer.copies()
    } catch (err) {
      unread = copiesUnreadSays(err instanceof Error ? err.message : String(err))
    }
    let taken: readonly string[]
    try {
      taken = (await writePublic(offer.path, name, copied, ask.say))?.taken ?? []
    } catch (err) {
      ask.say(err instanceof Error ? err.message : String(err))
      return false
    }
    ask.say(
      `surfaces.web.public is ${name}.${tookBackSays(taken)}${unread} ${await applies()} \`tade host caddy\` prints the site block for it.`,
    )
    return true
  }
  if (web === null || loopbackWrite(web, name) === null) return true
  if (!(await ask.confirm(loopbackAsks(name, web.port), false))) return true
  try {
    await writeLoopback(offer.path, name, ask.say)
  } catch (err) {
    ask.say(err instanceof Error ? err.message : String(err))
    return false
  }
  ask.say(
    `${name} is a trusted hostname, for a Caddy in front of the loopback listener. ${await applies()}`,
  )
  return true
}

/** The question for the one path a trusted hostname is for, asked once the public name is declined. */
export function loopbackAsks(name: string, port: number): string {
  return `Or is Caddy in front of the loopback listener — reverse_proxy 127.0.0.1:${port}, with no public socket? A request through it arrives there naming ${name}, which only surfaces.web.trusted_hosts lets in. Add it there?`
}

/**
 * Write `name` as `surfaces.web.public`, taking back every copy of a public
 * name Tade wrote into `surfaces.web.trusted_hosts` before (`publicWrite`).
 * Null where it already is the public name.
 *
 * Only ever called on a press, or `--write`: the name is the one the person
 * gave, and nothing here guesses one.
 */
export async function writePublic(
  path: string,
  name: string,
  copied: readonly string[],
  unrecorded: Unrecorded,
): Promise<{ public: string; taken: string[] } | null> {
  const wanted = publicWrite(await webIn(path), name, copied)
  if (wanted === null) return null
  await written(
    path,
    [
      ['surfaces.web.public', wanted.public],
      ...(wanted.taken.length === 0
        ? []
        : [['surfaces.web.trusted_hosts', wanted.trusted_hosts] as const]),
    ],
    unrecorded,
  )
  return { public: wanted.public, taken: wanted.taken }
}

/**
 * Add `name` to `surfaces.web.trusted_hosts`, for a Caddy in front of the
 * loopback listener (`loopbackWrite`). Null where it is there already. Only
 * ever called on a press.
 */
export async function writeLoopback(
  path: string,
  name: string,
  unrecorded: Unrecorded,
): Promise<string[] | null> {
  const wanted = loopbackWrite(await webIn(path), name)
  if (wanted === null) return null
  await written(path, [['surfaces.web.trusted_hosts', wanted]], unrecorded)
  return wanted
}

async function webIn(path: string) {
  const loaded = await loadConfig(path)
  if (!loaded.ok) throw new Error(`${path} does not load: \`tade config --check\` says why`)
  return loaded.config.surfaces.web
}

/**
 * Each key through the one write path, and the config read back: one that
 * would not load with them is put back as it was, and why is thrown. One that
 * stands is written down as `config_changed`, each key a line
 * (`recordFromShell`), which is what lets a later take-back tell what this
 * wrote from what somebody typed.
 */
async function written(
  path: string,
  keys: readonly (readonly [string, string | readonly string[]])[],
  unrecorded: Unrecorded,
): Promise<void> {
  let before: string | null = null
  try {
    before = readFileSync(path, 'utf8')
  } catch (err) {
    // No file yet: this write starts one, and putting it back is taking it away.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const held = heldIn(path)
  for (const [key, value] of keys) writeSetting(path, key, value)
  const after = await loadConfig(path)
  if (!after.ok) {
    if (before === null) rmSync(path, { force: true })
    else writeFileSync(path, before)
    throw new Error(after.issues[0]?.message ?? 'the config would not load with it')
  }
  const writes = keys.map(([key, value]) => ({ key, value }))
  await recordFromShell(path, held, writes, unrecorded)
}
