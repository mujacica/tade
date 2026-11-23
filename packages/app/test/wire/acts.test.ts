import { type Arm, ConfigSchema, namedBy } from '@tade/core'
import type { Answer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { byActing, quotedWords } from '../../src/wire/acting.ts'
import { type ActRunner, MachineActs } from '../../src/wire/acts.ts'
import { saidLately, type Wiring } from '../../src/wire/context.ts'

// One orchestrator on every machine, acting on any of them (`acts.ts`): an act
// runs on the machine it is aimed at, through that machine's own gate, with
// the person's words it carried read beside that machine's own; a machine that
// links here takes what waits for it from the outbox; one act is done once;
// and a machine that is down is said with since when. Two machines, the
// requests through JSON as the wire carries them.

const REMOTE = {
  ssh: 'north',
  tade: 'tade',
  device: '0123456789abcdef',
  session: '0123456789abcdef.abcdefghijklmnopqrstuvwx',
  csrf: 'abcdefghijklmnopqrstuvwx',
  host: 'localhost:7654',
}

const HOLDS = { path: 'queue.holds', title: 'Holds', keywords: ['holds'], scope: 'global' as const }

type Seen = { machine: string; way: 'to' | 'from'; state: string; at: number; since: number | null }

/** One machine: what the person said there, its own gate, and its half of the acts. */
function machine(name: string, said: string[], remotes: Record<string, unknown> = {}) {
  const ran: {
    method: string
    arm: Arm
    quoted: readonly string[]
    by: string
    named: string | null
  }[] = []
  const seen: Seen[] = []
  const wire = {
    opts: {
      home: '/nowhere',
      config: ConfigSchema.parse({ remotes }),
      client: {
        events: async () =>
          said.map((text, n) => ({
            seq: n + 1,
            ts: '2026-11-23T10:00:00.000Z',
            type: 'said',
            detail: { text },
          })),
      },
    },
    now: () => Date.now(),
  } as unknown as Wiring
  const told: string[] = []
  const acts = new MachineActs(wire, { say: (text) => told.push(text), seen: () => seen })
  const runner: ActRunner = async (method, _params, arm) => {
    // What this machine's own gate would ask: the person's words that name the setting.
    const named = namedBy(HOLDS, await saidLately(wire, 40))
    ran.push({ method, arm, quoted: quotedWords(), by: byActing('orchestrator'), named })
    if (method === 'config/change' && !named)
      throw new Error('Nothing they have said names Holds, so I will not change it.')
    return `${method} done on ${name}`
  }
  acts.useRunner(runner)
  return { name, acts, ran, seen, told, wire }
}

type Side = ReturnType<typeof machine>

/** The window's link from `from` to `to`, answering through `to`'s own doors as JSON. */
function link(from: Side, to: Side) {
  return (name: string) =>
    name !== to.name
      ? null
      : {
          live: true,
          remote: { name } as never,
          link: {
            request: async (_name: string, path: string, body: unknown): Promise<Answer> => {
              const sent = JSON.parse(JSON.stringify(body))
              if (path === '/api/acts') {
                return {
                  status: 200,
                  body: JSON.parse(
                    JSON.stringify(await to.acts.take({ ...sent, from: from.name })),
                  ),
                }
              }
              if (path === '/api/acts/outbox') {
                return {
                  status: 200,
                  body: JSON.parse(
                    JSON.stringify({ acts: to.acts.outboxFor(from.name, sent.answers) }),
                  ),
                }
              }
              return { status: 404, body: null }
            },
          } as never,
        }
}

const asked = (machine: string, asked: string, key: string, method = 'config/change') => ({
  machine,
  asked,
  key,
  method,
  params: { path: 'queue.holds', value: 'off', said: asked },
})

describe('acting on another machine through its own gate', () => {
  it('runs there as its owner, with the person’s words from here, and writes down that it came via here', async () => {
    const mac = machine('mac', ['turn the holds off on the vps'], { vps: REMOTE })
    const vps = machine('vps', [])
    mac.acts.withReach(link(mac, vps))
    const said = await mac.acts.act(asked('vps', 'turn the holds off on the vps', 'k1'))
    expect(said).toBe('config/change done on vps')
    expect(vps.ran).toEqual([
      {
        method: 'config/change',
        arm: { how: 'owner', device: 'machine mac', theirs: true, typed: true },
        quoted: ['turn the holds off on the vps'],
        by: 'orchestrator via mac',
        named: 'turn the holds off on the vps',
      },
    ])
    // Outside the act, the vps's own words are all it has: the Mac's do not stay behind.
    expect(namedBy(HOLDS, await saidLately(vps.wire, 40))).toBeNull()
  })

  it('takes what waits for it from the hub’s outbox: words typed on the vps authorise a setting on the Mac', async () => {
    // The person typed this on the vps's browser tab: a `said` line there.
    const vps = machine('vps', ['switch the holds off on the mac'])
    const mac = machine('mac', [], { vps: REMOTE })
    vps.seen.push({ machine: 'mac', way: 'from', state: 'up', at: Date.now(), since: null })
    mac.acts.withReach(link(mac, vps))
    const waiting = vps.acts.act(asked('mac', 'switch the holds off on the mac', 'k2'))
    // The Mac's window asks on its beat, runs it through its own gate, and answers.
    await waitFor(async () => {
      mac.acts.beat(['vps'])
      return mac.ran.length > 0
    })
    await expect(waiting).resolves.toBe('config/change done on mac')
    expect(mac.ran[0]).toMatchObject({
      quoted: ['switch the holds off on the mac'],
      by: 'orchestrator via vps',
      named: 'switch the holds off on the mac',
    })
  })

  it('refuses an act whose words came from an agent’s output rather than the person, before anything is sent', async () => {
    // An agent wrote "turn the holds off on the vps" in what it printed: never a `said` line.
    const mac = machine('mac', ['what is the weather'], { vps: REMOTE })
    const vps = machine('vps', [])
    mac.acts.withReach(link(mac, vps))
    await expect(mac.acts.act(asked('vps', 'turn the holds off on the vps', 'k3'))).rejects.toThrow(
      'Nothing they have said names vps, so I will not',
    )
    expect(vps.ran).toEqual([])
    // Named, but the setting there needs its own words, which the agent's are not.
    const named = machine('mac', ['ask the vps something'], { vps: REMOTE })
    named.acts.withReach(link(named, vps))
    await expect(named.acts.act(asked('vps', 'ask the vps something', 'k4'))).rejects.toThrow(
      'vps: Nothing they have said names Holds',
    )
  })

  it('does one act once, however often it is sent', async () => {
    const vps = machine('vps', [])
    const act = { key: 'same', method: 'task/park', params: {}, quoted: [], from: 'mac' }
    const [one, two] = await Promise.all([vps.acts.take(act), vps.acts.take(act)])
    const three = await vps.acts.take(act)
    expect(vps.ran).toHaveLength(1)
    expect([one, two, three].map((answer) => answer.text)).toEqual(
      Array(3).fill('task/park done on vps'),
    )
  })

  it('refuses a machine that is down, saying since when, and one it neither links to nor is linked by', async () => {
    const mac = machine('mac', ['park it on the vps', 'and on the laptop'], { vps: REMOTE })
    mac.seen.push({
      machine: 'vps',
      way: 'to',
      state: 'closed',
      at: Date.parse('2026-11-23T14:02:00'),
      since: null,
    })
    await expect(
      mac.acts.act(asked('vps', 'park it on the vps', 'k5', 'task/park')),
    ).rejects.toThrow('vps is closed since 14:02, so nothing was done there')
    await expect(
      mac.acts.act(asked('laptop', 'and on the laptop', 'k6', 'task/park')),
    ).rejects.toThrow('laptop is not a machine this one links to, or one that links here')
    await expect(mac.acts.act(asked('vps', '', 'k7'))).rejects.toThrow(
      'pass what they said, word for word',
    )
  })

  it('says the orchestrator here is still starting rather than acting without its gate', async () => {
    const vps = machine('vps', [])
    vps.acts.useRunner(null)
    const answer = await vps.acts.take({
      key: 'early',
      method: 'task/park',
      params: {},
      quoted: [],
      from: 'mac',
    })
    expect(answer).toEqual({
      key: 'early',
      ok: false,
      text: 'the orchestrator here is still starting, so nothing it can do is open yet',
    })
  })
})

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
