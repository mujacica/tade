import { SERVICE, type ServiceState, START } from '@tade/core'
import type { TadeLook } from '@tade/workbench/programs'
import type { Opened } from '@tade/workbench/upgrade'
import { describe, expect, it } from 'vitest'
import type { Asker } from '../src/commands/host-service.ts'
import {
  goingBack,
  type UpgradeOptions,
  type UpgradePlace,
  unitStarts,
  upgradeHere,
} from '../src/commands/host-upgrade.ts'

// `tade host upgrade`, decided: what is said, what is asked, what is run and
// what is never run. Every answer the machine gives is handed in as the
// machine gives it — the look at Tade, the holder of the home, the service,
// the journal's openings — so each case is one a box can be in. That systemd
// restarts `tade serve` with the agents left running is
// `set-up-the-machine`'s "Proving it"; that the journal says which Tade opened
// is `workbench/test/upgrade.test.ts`.

interface Recorder extends Asker {
  said: string[]
  asked: string[]
  ran: string[]
}

function recorder(answers: boolean[] = [], codes: number[] = []): Recorder {
  const said: string[] = []
  const asked: string[] = []
  const ran: string[] = []
  const pressed = [...answers]
  const ended = [...codes]
  return {
    said,
    asked,
    ran,
    say: (text) => said.push(text),
    async confirm(question, fallback) {
      asked.push(question)
      return pressed.shift() ?? fallback
    },
    async run(_title, command, args) {
      ran.push(command === '/bin/sh' && args[0] === '-c' ? (args[1] ?? '') : command)
      return ended.shift() ?? 0
    },
  }
}

const NPM = 'npm install --global tade-sh@latest'

function looked(change: Partial<TadeLook> = {}): TadeLook {
  return {
    version: '0.2.3',
    from: 'install',
    where: '/usr/lib/node_modules/tade-sh',
    branch: null,
    commit: null,
    install: null,
    newer: '0.2.4 is out',
    cannotTell: null,
    update: { command: NPM },
    ...change,
  }
}

const ready = (pid: number): ServiceState => ({ kind: 'ready', pid, status: '' })

/** A box, as each of its answers says. `services` is how the service stands at each look. */
function box(
  opts: {
    look?: TadeLook
    held?: number | null
    services?: (ServiceState | null)[]
    opened?: Record<number, Opened>
    starts?: { version: string; said: null } | { version: null; said: string }
    stops?: string | null
    backup?: { ok: boolean; said: string } | null
  } = {},
): UpgradePlace & { waited: number[] } {
  const services = [...(opts.services ?? [null])]
  const waited: number[] = []
  return {
    waited,
    look: async () => opts.look ?? looked(),
    lanesWouldStop: async () => opts.stops ?? null,
    held: async () => opts.held ?? null,
    service: async () => (services.length > 1 ? services.shift() : services[0]) ?? null,
    opened: async (pid) => opts.opened?.[pid] ?? null,
    starts: async () => opts.starts ?? { version: '0.2.4', said: null },
    backup: async () => opts.backup ?? null,
    wait: async (ms) => {
      waited.push(ms)
    },
  }
}

const PRESSED: UpgradeOptions = { yes: false, asking: true, backup: true }

describe('upgrading Tade in place', () => {
  it('does nothing where it is current, and what holds the home runs what is on disk', async () => {
    const ask = recorder()
    const place = box({
      look: looked({ newer: null }),
      held: 10,
      opened: { 10: { version: '0.2.3', lanes: 2 } },
    })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(0)
    expect(ask.said).toEqual([
      'Tade 0.2.3, /usr/lib/node_modules/tade-sh',
      '  it is current: nothing to do',
    ])
    expect(ask.ran).toEqual([])
  })

  it('runs the install’s own command on a press, and says the next tade runs it where nothing holds the home', async () => {
    const ask = recorder([true])
    expect(await upgradeHere(ask, box(), PRESSED)).toBe(0)
    expect(ask.asked).toEqual([`run \`${NPM}\`?`])
    expect(ask.ran).toEqual([NPM])
    expect(ask.said.slice(-2)).toEqual([
      '  0.2.4 is installed',
      '  nothing has this home open: the next `tade` runs 0.2.4',
    ])
  })

  it('runs nothing from a pipe without --yes, and nothing on a no', async () => {
    const piped = recorder()
    expect(await upgradeHere(piped, box(), { yes: false, asking: false, backup: true })).toBe(2)
    expect(piped.said.at(-1)).toBe(`  \`tade host upgrade --yes\` runs \`${NPM}\``)
    expect(piped.ran).toEqual([])
    const declined = recorder([false])
    expect(await upgradeHere(declined, box(), PRESSED)).toBe(0)
    expect(declined.said.at(-1)).toBe('  not upgraded')
    expect(declined.ran).toEqual([])
  })

  it('restarts nothing where the install failed, or where what it installed does not start', async () => {
    const failed = recorder([true], [1])
    expect(await upgradeHere(failed, box({ held: 10, services: [ready(10)] }), PRESSED)).toBe(1)
    expect(failed.ran).toEqual([NPM])
    expect(failed.said.at(-1)).toContain('nothing was restarted')

    const broken = recorder([true])
    const place = box({
      held: 10,
      services: [ready(10)],
      opened: { 10: { version: '0.2.3', lanes: 1 } },
      starts: { version: null, said: 'TypeError: x is not a function' },
    })
    expect(await upgradeHere(broken, place, PRESSED)).toBe(1)
    expect(broken.ran).toEqual([NPM])
    expect(broken.said.slice(-2)).toEqual([
      '  the Tade now here does not start (TypeError: x is not a function), so nothing was restarted',
      '  to go back to 0.2.3: `npm install --global tade-sh@0.2.3`',
    ])
  })

  it('leaves a window somebody has open to reload on its own press', async () => {
    const ask = recorder([true])
    const place = box({
      held: 10,
      services: [ready(99)],
      opened: { 10: { version: '0.2.3', lanes: 4 } },
    })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(0)
    expect(ask.ran).toEqual([NPM])
    expect(ask.said.at(-1)).toBe(
      '  a window has this home open (pid 10) and runs 0.2.3 until it reloads: its strip says `reload Tade`',
    )
  })

  it('never restarts a service whose agents would stop with it, and says how', async () => {
    const ask = recorder([true])
    const place = box({
      held: 10,
      services: [ready(10)],
      opened: { 10: { version: '0.2.3', lanes: 4 } },
      stops: 'agents run under the pty driver, so they stop whenever the service does',
    })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(0)
    expect(ask.ran).toEqual([NPM])
    expect(ask.said.slice(-2)).toEqual([
      '  not restarted, because agents run under the pty driver, so they stop whenever the service does',
      `  restart it when nothing is working: \`${START}\``,
    ])
  })

  it('restarts the service on a press, and says from the journal which Tade came back with how many lanes', async () => {
    const ask = recorder([true, true])
    const place = box({
      held: 10,
      services: [ready(10), { kind: 'starting', pid: 11 }, ready(11)],
      opened: { 10: { version: '0.2.3', lanes: 4 }, 11: { version: '0.2.4', lanes: 4 } },
    })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(0)
    expect(ask.asked).toEqual([
      `run \`${NPM}\`?`,
      `restart ${SERVICE} onto 0.2.4? Agents keep working`,
    ])
    expect(ask.ran).toEqual([NPM, START])
    expect(ask.said.at(-1)).toBe(`  ${SERVICE} runs 0.2.4 now, and took up its 4 lanes again`)
    expect(place.waited).toEqual([2_000])
  })

  it('restarts a service still on the Tade before an upgrade already on disk, installing nothing', async () => {
    const ask = recorder([true])
    const place = box({
      look: looked({ newer: null }),
      held: 10,
      services: [ready(10), ready(12)],
      opened: { 10: { version: '0.2.2', lanes: 1 }, 12: { version: '0.2.3', lanes: 1 } },
      starts: { version: '0.2.3', said: null },
    })
    expect(await upgradeHere(ask, place, { yes: true, asking: false, backup: true })).toBe(0)
    expect(ask.ran).toEqual([START])
    expect(ask.said).toContain(
      '  0.2.3 is installed, and the Tade holding this home still runs 0.2.2',
    )
  })

  it('says a service that failed to come back, with the way back, and one that came back as something else', async () => {
    const failing = recorder()
    const failed = box({
      held: 10,
      services: [ready(10), { kind: 'failed', result: 'exit-code' }],
      opened: { 10: { version: '0.2.3', lanes: 1 } },
    })
    expect(await upgradeHere(failing, failed, { yes: true, asking: false, backup: true })).toBe(1)
    expect(failing.said.at(-1)).toBe(
      `  to go back: \`npm install --global tade-sh@0.2.3 && ${START}\``,
    )
    const other = recorder()
    const wrong = box({
      held: 10,
      services: [ready(10), ready(13)],
      opened: { 10: { version: '0.2.3', lanes: 1 }, 13: { version: '0.2.3', lanes: 1 } },
    })
    expect(await upgradeHere(other, wrong, { yes: true, asking: false, backup: true })).toBe(1)
    expect(other.said.at(-1)).toBe(`  ${SERVICE} came back as 0.2.3, not 0.2.4`)
  })

  it('gives up waiting after two minutes, saying where to look', async () => {
    const ask = recorder()
    const place = box({
      held: 10,
      services: [ready(10), { kind: 'starting', pid: 11 }],
      opened: { 10: { version: '0.2.3', lanes: 1 } },
    })
    expect(await upgradeHere(ask, place, { yes: true, asking: false, backup: true })).toBe(1)
    expect(place.waited.length).toBe(61)
    expect(ask.said.at(-1)).toContain('has not said which Tade it is after two minutes')
  })

  it('says a service that runs the new one already, and from a pipe the restart it would run', async () => {
    const already = recorder([true])
    const place = box({
      held: 10,
      services: [ready(10)],
      opened: { 10: { version: '0.2.4', lanes: 1 } },
    })
    expect(await upgradeHere(already, place, PRESSED)).toBe(0)
    expect(already.said.at(-1)).toBe(`  ${SERVICE} runs 0.2.4 already`)

    const piped = recorder()
    const old = box({
      look: looked({ newer: null }),
      held: 10,
      services: [ready(10)],
      opened: { 10: { version: '0.2.2', lanes: 1 } },
      starts: { version: '0.2.3', said: null },
    })
    expect(await upgradeHere(piped, old, { yes: false, asking: false, backup: true })).toBe(0)
    expect(piped.said.at(-1)).toBe(`  restart it onto 0.2.3: \`${START}\` — agents keep working`)
    expect(piped.ran).toEqual([])
  })

  it('refuses where nothing here can move Tade forward', async () => {
    const ask = recorder()
    const place = box({
      look: looked({ update: { cannot: 'Tade cannot tell how it was installed' } }),
    })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(1)
    expect(ask.said.at(-1)).toBe(
      '  Tade cannot move itself forward here: Tade cannot tell how it was installed',
    )
  })

  it('takes a backup first where one is set up, and asks before going on without one', async () => {
    const backed = recorder([true])
    expect(await upgradeHere(backed, box({ backup: { ok: true, said: '' } }), PRESSED)).toBe(0)
    expect(backed.said).toContain('  backed up first')

    const notBacked = recorder([false])
    const failed = box({ backup: { ok: false, said: 'Fatal: no route to host' } })
    expect(await upgradeHere(notBacked, failed, PRESSED)).toBe(1)
    expect(notBacked.asked).toEqual(['upgrade anyway?'])
    expect(notBacked.ran).toEqual([])
    // --yes is no press for going on without the backup it was asked to take.
    const scripted = recorder()
    expect(await upgradeHere(scripted, failed, { yes: true, asking: false, backup: true })).toBe(1)
    expect(scripted.said.at(-1)).toBe('  not upgraded: `--no-backup` upgrades without one')
    const skipped = recorder()
    expect(await upgradeHere(skipped, failed, { yes: true, asking: false, backup: false })).toBe(0)
    expect(skipped.ran).toEqual([NPM])
  })

  it('says it cannot tell what is current, and still offers the install’s own command', async () => {
    const ask = recorder([true])
    const place = box({ look: looked({ newer: null, cannotTell: 'the registry did not answer' }) })
    expect(await upgradeHere(ask, place, PRESSED)).toBe(0)
    expect(ask.said[1]).toBe(
      '  whether a newer one is out cannot be told: the registry did not answer',
    )
    expect(ask.ran).toEqual([NPM])
  })
})

describe('the words around it', () => {
  it('goes back by the install’s own command, where it names a version', () => {
    expect(goingBack(NPM, '0.2.3')).toBe('npm install --global tade-sh@0.2.3')
    expect(goingBack('pnpm add --global tade-sh@latest', '0.2.1')).toBe(
      'pnpm add --global tade-sh@0.2.1',
    )
    expect(goingBack('brew upgrade tade', '0.2.3')).toBeNull()
    expect(goingBack('git -C /opt/tade pull --ff-only && pnpm install', '0.2.3')).toBeNull()
  })

  it('reads what the unit starts, as far as `serve`', () => {
    expect(unitStarts('[Service]\nExecStart=/usr/bin/node "/opt/my tade/bin.ts" serve\n')).toEqual([
      '/usr/bin/node',
      '/opt/my tade/bin.ts',
    ])
    expect(unitStarts('[Service]\nExecStart=/usr/bin/tmux new -d tade app\n')).toBeNull()
    expect(unitStarts(null)).toBeNull()
  })
})
