import {
  type CarryLine,
  compareStamps,
  laterOf,
  lineStamp,
  pathsMeet,
  type Stamp,
  stampOf,
  stampText,
  tick,
} from '@tade/core'

// Every `config_changed` line is stamped by the journal that writes it — the
// one writer per home — with a hybrid-clock stamp (`@tade/core`'s `hlc.ts`)
// and the stamp it was made over, which is what lets two machines keeping
// their settings in step tell the later change from the earlier, and a
// change made without seeing the other's from one made after it (`settle`).
//
// In the journal rather than in each writer because there are a dozen
// writers — the Settings page, the orchestrator's tool, a phone, a terminal's
// spool, the accounts, a carry — and a stamp one of them forgot would be a
// change that loses to everything. A line that already carries a stamp is a
// carry writing another machine's change: kept as it came, and this clock
// moved up to it, so nothing written here afterwards is ever earlier.

export class SettingStamps {
  private readonly machine: string
  private last: Stamp | null = null
  /** The newest stamp per path written here: what a change is made over. */
  private readonly held = new Map<string, Stamp | null>()

  constructor(machine: string) {
    this.machine = machine
  }

  /** A clock caught up with every `config_changed` line already in a journal, oldest first. */
  static from(lines: readonly CarryLine[], machine: string): SettingStamps {
    const stamps = new SettingStamps(machine)
    for (const line of lines) {
      if (line.type !== 'config_changed') continue
      const path = line.detail?.path
      if (typeof path !== 'string') continue
      const stamp = lineStamp(line.detail, line.ts)
      stamps.last = laterOf(stamps.last, stamp)
      stamps.held.set(path, stamp)
    }
    return stamps
  }

  /** The detail of a `config_changed` line about to be written, with its stamp and what it was made over. */
  stamp(detail: Readonly<Record<string, unknown>>, now: number): Record<string, unknown> {
    const path = detail.path
    if (typeof path !== 'string') return { ...detail }
    const given = stampOf(detail.hlc)
    if (given !== null) {
      this.last = laterOf(this.last, given)
      this.held.set(path, given)
      return { ...detail }
    }
    const stamp = tick(this.last, now, this.machine)
    let over: Stamp | null = null
    for (const [at, held] of this.held) {
      if (pathsMeet(at, path) && compareStamps(held, over) > 0) over = held
    }
    this.last = stamp
    this.held.set(path, stamp)
    return {
      ...detail,
      hlc: stampText(stamp),
      ...(over === null ? {} : { over: stampText(over) }),
    }
  }
}
