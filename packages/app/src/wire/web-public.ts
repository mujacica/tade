import { type CertificateLook, certificateSays, type Health, outdatedSays } from '@tade/core'

// The health of the public listener, while there is one: the certificate the
// name answers with, and whether this Tade is behind while the internet can
// reach it.
//
// **Two looks on clocks of their own, both only while the public listener is
// up.** The certificate is one TLS handshake to the name — what a phone gets —
// twice a day, and an hour after a look that could not be made; certificates
// renew every few weeks, so more often would be asking the world for nothing.
// Whether Tade is behind is the Updates check's own answer, kept in
// `updates.json` (`lastUpdates`), read again every quarter of an hour: this
// asks nobody anything, and the Updates page's clock stays the one that dials.
//
// **Loud is said in the strip, once.** The panel draws every line on every
// frame; what nobody may miss — a certificate running out, a renewal that has
// been failing, Tade behind on a box the internet reaches (REMOTE-TADE §8.5) —
// is also told to the person through `news`, once per thing to say, and again
// only after it was fine in between.

/** How often the certificate is looked at, while it could be. */
export const CERTIFICATE_EVERY_MS = 12 * 3_600_000
/** How soon a look that could not be made is tried again. */
export const CERTIFICATE_RETRY_MS = 3_600_000
/** How often the kept answer to *is Tade behind* is read again. */
export const BEHIND_EVERY_MS = 15 * 60_000

export interface PublicHealthDeps {
  /**
   * How to look at the certificate `name` answers with, or null where this
   * window may not dial. Asked at the beat, so it is the window's options now.
   */
  look: () => ((name: string) => Promise<CertificateLook>) | null
  /** The kept answer's clause for a newer Tade, or null. A file read, never a question. */
  newer: () => Promise<string | null>
  news: (said: string) => void
  draw: () => void
  now: () => number
}

export class PublicHealth {
  private readonly deps: PublicHealthDeps
  /** The public name the listener is up for, or null while it is not. */
  private name: string | null = null
  private certificate: CertificateLook | null = null
  private behind: string | null = null
  private looking = false
  private reading = false
  private readAt = Number.NEGATIVE_INFINITY
  /** What has been said in the strip, by what it is about, so it is said once. */
  private readonly told = new Map<string, string>()

  constructor(deps: PublicHealthDeps) {
    this.deps = deps
  }

  /** The listener came up for `name`, or went (null). A new name forgets the old one's look. */
  up(name: string | null): void {
    if (name === this.name) return
    this.name = name
    this.certificate = null
    this.behind = null
    this.readAt = Number.NEGATIVE_INFINITY
    this.told.clear()
  }

  /** On the window's beat: start whichever look is due. Never waits on either. */
  beat(): void {
    const name = this.name
    if (name === null) return
    const now = this.deps.now()
    const look = this.deps.look()
    if (look !== null && !this.looking && this.due(now)) {
      this.looking = true
      void look(name)
        // A look that threw is one that could not be made, and waits its hour
        // like one: never a look again on the next beat.
        .catch((err: unknown) => ({ at: now, cannot: String(err) }) as CertificateLook)
        .then((seen) => {
          if (this.name === name) this.certificate = seen
        })
        .finally(() => {
          this.looking = false
          this.said()
        })
    }
    if (!this.reading && now - this.readAt >= BEHIND_EVERY_MS) {
      this.reading = true
      this.readAt = now
      void this.deps
        .newer()
        .then((newer) => {
          if (this.name === name) this.behind = newer
        })
        .finally(() => {
          this.reading = false
          this.said()
        })
    }
  }

  /** What the panel draws under its status line, loudest first. Empty while there is no public listener. */
  lines(): Health[] {
    const name = this.name
    if (name === null) return []
    const now = this.deps.now()
    const out: Health[] = []
    const behind = outdatedSays(name, this.behind)
    if (behind !== null) out.push(behind)
    if (this.certificate !== null) out.push(certificateSays(name, this.certificate, now))
    else if (this.deps.look() === null)
      out.push({ said: 'certificate: not looked at', loud: false })
    else out.push({ said: 'certificate: looking', loud: false })
    return out.sort((a, b) => Number(b.loud) - Number(a.loud))
  }

  private due(now: number): boolean {
    const last = this.certificate
    if (last === null) return true
    return now - last.at >= ('cannot' in last ? CERTIFICATE_RETRY_MS : CERTIFICATE_EVERY_MS)
  }

  /** Tell what became loud, once each; forget what became fine, so it is told again if it comes back. */
  private said(): void {
    const name = this.name
    if (name === null) return
    const now = this.deps.now()
    const about: [string, Health | null][] = [
      ['behind', outdatedSays(name, this.behind)],
      [
        'certificate',
        this.certificate === null ? null : certificateSays(name, this.certificate, now),
      ],
    ]
    for (const [what, health] of about) {
      if (health === null || !health.loud) {
        this.told.delete(what)
        continue
      }
      // Keyed by the kind of trouble and not the sentence, which counts days down.
      const kind = what === 'behind' ? (this.behind ?? '') : kindOf(this.certificate)
      if (this.told.get(what) === kind) continue
      this.told.set(what, kind)
      this.deps.news(health.said)
    }
    this.deps.draw()
  }
}

/** Which way a certificate is in trouble, so a count of days going down is not news each time. */
function kindOf(look: CertificateLook | null): string {
  if (look === null) return ''
  if ('cannot' in look) return 'cannot'
  if (!look.seen.authorized) return 'unverified'
  return look.seen.validTo <= look.at ? 'expired' : 'late'
}
