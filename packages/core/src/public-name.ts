// The public name written, and what that leaves in `surfaces.web.trusted_hosts`:
// `tade host domain` and the Public name row in Settings › Away view.
//
// **A public name is trusted on its own.** `surfaceOf` (`@tade/web`) puts it
// first among the trusted hosts on every listener while it is set, and nowhere
// once it is not. A copy of it in `trusted_hosts` adds nothing while it is the
// name and outlives it once it is not — trust on a public box that nobody
// meant. So writing the name writes the name alone, and takes back every copy
// Tade wrote there before: until 2026-10-17 a name typed in the Public name row
// was added to the trusted hostnames on the same press.
//
// **`trusted_hosts` is for the one path that needs it**: a Caddy in front of
// the loopback listener, with no public socket. A request through it lands on
// the loopback listener naming the public name as its `Host`, and only a
// trusted hostname lets that in. Offered as that, and on a press
// (`loopbackWrite`), never as a side effect of the public name.
//
// Pure: the config and the journal's lines in, what to write out.

const PUBLIC = 'surfaces.web.public'
const TRUSTED = 'surfaces.web.trusted_hosts'

/** The two keys, as the config has them. */
export interface PublicAndTrusted {
  public: string
  trusted_hosts: readonly string[]
}

/** What one `config_changed` line says, as much of it as `copiedHosts` reads. */
export interface ChangedLine {
  seq: number
  ts: string
  detail?: Readonly<Record<string, unknown>>
}

/**
 * `name` written as the public name — `''` clears it — with every one of
 * `copied` taken out of the trusted hostnames, or null where it already is the
 * public name.
 *
 * **Only ever on a press.** The name is the one the person gave, and nothing
 * here guesses one: a name Tade typed in would be a decision about who reaches
 * this machine made by something other than the person.
 */
export function publicWrite(
  web: PublicAndTrusted,
  name: string,
  copied: readonly string[],
): { public: string; trusted_hosts: string[]; taken: string[] } | null {
  const named = hostName(name)
  if (hostName(web.public) === named) return null
  return { public: named, ...withoutCopies(web.trusted_hosts, copied) }
}

/**
 * The trusted hostnames with every one of `copied` taken out, and which those
 * were. **Never a name the person put there**: `copied` is what the journal
 * says Tade wrote (`copiedHosts`), so a name typed in stays, and so does one
 * that was there before Tade copied it.
 */
export function withoutCopies(
  trusted: readonly string[],
  copied: readonly string[],
): { trusted_hosts: string[]; taken: string[] } {
  const copies = new Set(copied.map(hostName))
  return {
    trusted_hosts: trusted.filter((one) => !copies.has(hostName(one))),
    taken: trusted.filter((one) => copies.has(hostName(one))),
  }
}

/** What is said of the copies a public name's write took back, after "Saved." or the name. */
export function tookBackSays(taken: readonly string[]): string {
  if (taken.length === 0) return ''
  const one = taken.length === 1
  return ` ${taken.join(', ')} ${one ? 'is no longer a trusted hostname' : 'are no longer trusted hostnames'}: Tade had copied ${one ? 'it' : 'them'} there beside a public name, which is trusted on its own.`
}

/**
 * What is said where the journal could not be read for Tade's copies, so none
 * were taken back: what happened first, because Settings draws it on one line
 * and cuts what does not fit.
 */
export function copiesUnreadSays(why: string): string {
  return ` Trusted hostnames left as they were: the journal, which says which of them Tade copied there, could not be read (${why}).`
}

/**
 * The trusted hostnames with `name` added, for a Caddy in front of the loopback
 * listener with no public socket — or null where it is there already. Added
 * rather than replacing, so a tailnet name already there stays.
 */
export function loopbackWrite(web: PublicAndTrusted, name: string): string[] | null {
  const named = hostName(name)
  if (web.trusted_hosts.some((one) => hostName(one) === named)) return null
  return [...web.trusted_hosts, named]
}

/**
 * The trusted hostnames Tade itself copied there beside a public name, and
 * nobody has put there or taken away since — out of the journal's
 * `config_changed` lines.
 *
 * **A copy is the line Settings wrote beside the public name**: one name added
 * to the trusted hostnames on the line straight after the public name was
 * written as that name, by the same hand and in the same second. The two were
 * appended in one loop and a line's `seq` is given as it is appended, so
 * nothing could come between them; a person typing the same name in a moment
 * later is a second press, and a second has passed. Any other line that adds a
 * name is somebody putting it there, which makes it theirs, and one that takes
 * it away — or whose `was` no longer has it — ends the copy either way.
 *
 * The CLI's lines are read the same way, `by: cli` (`recordFromShell`): one
 * that takes a copy away ends it, and one that adds a name makes it somebody's.
 * What the CLI copied before it wrote any — `tade host domain --write` from
 * 1321b946 to b5072d57, never in a release — has no line, so it cannot be told
 * from a name typed into the file, and stays.
 */
export function copiedHosts(lines: readonly ChangedLine[]): string[] {
  const copied = new Set<string>()
  let before: ChangedLine | null = null
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    const detail = line.detail ?? {}
    if (detail.path === TRUSTED) {
      const was = hostsIn(detail.was)
      const now = hostsIn(detail.now)
      for (const one of copied) if (!was.includes(one) || !now.includes(one)) copied.delete(one)
      const added = now.filter((one) => !was.includes(one))
      const copy = added.length === 1 && before !== null && copyOf(before, line, added[0] ?? '')
      for (const one of added) {
        if (copy) copied.add(one)
        else copied.delete(one)
      }
    }
    before = line
  }
  return [...copied]
}

/** Whether `line`, adding `name` to the trusted hostnames, is Settings' copy of the public name `before` wrote. */
function copyOf(before: ChangedLine, line: ChangedLine, name: string): boolean {
  const wrote = before.detail ?? {}
  if (wrote.path !== PUBLIC || before.seq !== line.seq - 1) return false
  if (typeof wrote.now !== 'string' || hostName(wrote.now) !== name) return false
  if (wrote.by !== line.detail?.by) return false
  const apart = Math.abs(Date.parse(line.ts) - Date.parse(before.ts))
  return apart < 1_000
}

/** The names a `was` or `now` holds: what Settings wrote, the list joined with spaces. */
function hostsIn(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,]+/)
    .filter((one) => one !== '')
    .map(hostName)
}

function hostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}
