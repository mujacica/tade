import { type DomainSeen, domainHead, domainSays } from '@tade/core'
import type { DomainView } from '../panels/settings/domain.ts'

// The look behind the Public name row in Settings › Away view: what `tade host
// domain` asks, asked from the window and drawn under the row.
//
// **Asked when somebody is looking, never on a clock.** Once each time the
// Settings page is opened on a name, and again on Look again — "not yet
// visible" is minutes, and the person waiting on it is the one to say when to
// look. A name written in the row is a new name, and is looked at.
//
// **Only a real window dials** (`AppOptions.domain`, handed by the CLI): a
// test's window draws nothing under the row rather than asking the world.

export interface DomainLookDeps {
  /** How to look at `name`, or null where this window may not dial. */
  look: () => ((name: string) => Promise<DomainSeen>) | null
  draw: () => void
}

export class DomainLook {
  private readonly deps: DomainLookDeps
  private name: string | null = null
  private seen: DomainSeen | null = null
  /** Why the last look came back with nothing, where it threw. */
  private failed: string | null = null
  private looking = false
  /** Whether this opening of the page has looked yet. */
  private asked = false

  constructor(deps: DomainLookDeps) {
    this.deps = deps
  }

  /** The page shows the row for `name`: look, once for this opening. */
  want(name: string): void {
    if (name !== this.name) {
      this.name = name
      this.seen = null
      this.failed = null
      this.asked = false
    }
    if (!this.asked) this.again()
  }

  /** The page was opened again: the next `want` looks again. */
  forget(): void {
    this.asked = false
  }

  /** Look now, unless a look is already under way. */
  again(): void {
    const name = this.name
    const look = this.deps.look()
    if (name === null || look === null || this.looking) return
    this.asked = true
    this.looking = true
    // `lookAtDomain` never throws — what it could not ask is in what it says —
    // so a look that did is said where its answer would have been, rather than
    // left saying it is still looking.
    void look(name)
      .then(
        (seen) => {
          if (this.name !== name) return
          this.seen = seen
          this.failed = null
        },
        (err: unknown) => {
          if (this.name === name) this.failed = err instanceof Error ? err.message : String(err)
        },
      )
      .finally(() => {
        this.looking = false
        this.deps.draw()
      })
    this.deps.draw()
  }

  /** What the row draws under it, for `name`; null where this window does not look. */
  view(name: string): DomainView | null {
    if (this.deps.look() === null || name !== this.name) return null
    const seen = this.seen
    if (seen === null && this.failed !== null) {
      return { name, looking: this.looking, head: `could not look: ${this.failed}`, lines: [] }
    }
    return {
      name,
      looking: this.looking,
      head: seen === null ? null : domainHead(seen),
      lines: seen === null ? [] : domainSays(seen),
    }
  }
}
