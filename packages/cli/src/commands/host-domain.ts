import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  type DomainLine,
  type DomainSeen,
  domainHead,
  domainSays,
  loadConfig,
  publicName,
  refusedName,
  trustedWrite,
  writeSetting,
} from '@tade/core'

// `tade host domain <name>`: the records a public name needs, looked at from
// the box, a line each — missing, wrong, not yet visible, or right — with the
// record to add or take away under it, exactly; then, on a press, the name
// written as the public name and a trusted hostname.
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

/**
 * Write `name` as `surfaces.web.public` and add it to
 * `surfaces.web.trusted_hosts` (`trustedWrite`), through the one write path,
 * and read the config back: one that would not load with it is put back as it
 * was, and why is thrown. Null where both already name it.
 *
 * Only ever called on a press, or `--write`: the name is the one the person
 * gave, and nothing here guesses one.
 */
export async function writeTrusted(
  path: string,
  name: string,
): Promise<{ public: string; trusted_hosts: string[] } | null> {
  const loaded = await loadConfig(path)
  if (!loaded.ok) throw new Error(`${path} does not load: \`tade config --check\` says why`)
  const wanted = trustedWrite(loaded.config.surfaces.web, name)
  if (wanted === null) return null
  let before: string | null = null
  try {
    before = readFileSync(path, 'utf8')
  } catch (err) {
    // No file yet: this write starts one, and putting it back is taking it away.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  writeSetting(path, 'surfaces.web.public', wanted.public)
  writeSetting(path, 'surfaces.web.trusted_hosts', wanted.trusted_hosts)
  const after = await loadConfig(path)
  if (!after.ok) {
    if (before === null) rmSync(path, { force: true })
    else writeFileSync(path, before)
    throw new Error(after.issues[0]?.message ?? 'the config would not load with it')
  }
  return wanted
}
