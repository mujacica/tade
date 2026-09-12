import { historyFrom, type KnownTask, type WilcoEvent } from '@wilco/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Speaker } from '../src/speaker.ts'
import { type Turn, type VoiceDaemon, VoiceSurface } from '../src/voice.ts'

// Working out which agent you meant, and asking when the evidence doesn't
// single one out.

const NOW = Date.parse('2026-09-11T14:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const task = (id: string, state: KnownTask['state']): KnownTask => ({
  id,
  project: id.split('/')[0] ?? id,
  state,
})

function fakeDaemon() {
  const calls: string[] = []
  const daemon: VoiceDaemon & { calls: string[] } = {
    calls,
    async pendingApprovals() {
      return []
    },
    async decideApproval() {},
    async runs() {
      return [
        { run: 'r-refunds', task: 'checkout/refunds' },
        { run: 'r-pagination', task: 'search/pagination' },
      ]
    },
    async steerRun(run, message) {
      calls.push(`steer ${run} ${message}`)
    },
    async parkTask(worktree, parked) {
      calls.push(`park ${worktree} ${parked}`)
      return { task: 'x', parked }
    },
    async createTask() {
      return { id: 'x/y', worktree: '/wt/y' }
    },
    async startRun() {
      return { run: 'r1' }
    },
    async subscribe() {
      return 'sub-1'
    },
  }
  return daemon
}

async function surface(
  daemon: ReturnType<typeof fakeDaemon>,
  over: {
    tasks?: KnownTask[]
    events?: WilcoEvent[]
    focused?: string | null
  } = {},
) {
  const said: string[] = []
  const turns: Turn[] = []
  const speaker = await Speaker.create({
    soundDir: tmp('wilco-reason-'),
    platform: 'darwin',
    run: async ({ command, args }) => {
      if (command === 'say') said.push(args.at(-1) ?? '')
    },
  })
  const tasks = over.tasks ?? [
    task('checkout/refunds', 'working'),
    task('checkout/stripe-v15', 'blocked'),
    task('search/pagination', 'working'),
  ]
  const voice = await VoiceSurface.start({
    daemon,
    speaker,
    now: () => NOW,
    localHour: () => 14,
    vocabulary: async () => ({
      tasks: tasks.map((t) => t.id),
      projects: [...new Set(tasks.map((t) => t.project))],
    }),
    status: async () => 'All quiet.',
    worktreeOf: async (id) => `/wt/${id.split('/').at(-1)}`,
    tasks: async () => tasks,
    history: async () => historyFrom(over.events ?? [], NOW),
    focusedTask: () => ({ task: over.focused ?? null, lastInputAt: null }),
    onTurn: (turn) => turns.push(turn),
  })
  return { voice, said, turns }
}

const event = (type: WilcoEvent['type'], task: string, ts: string): WilcoEvent => ({
  seq: 1,
  ts,
  type,
  urgency: 'notable',
  task,
  lane: null,
  run: 'r1',
  detail: {},
})

describe('working out which agent you meant', () => {
  let daemon: ReturnType<typeof fakeDaemon>
  beforeEach(() => {
    daemon = fakeDaemon()
  })

  it('uses what you are looking at when you say "it"', async () => {
    const { voice, turns } = await surface(daemon, { focused: 'search/pagination' })
    expect(await voice.handle('park it')).toBe('Parked pagination.')
    expect(daemon.calls).toEqual(['park /wt/pagination true'])
    // The app can show why it chose that one.
    expect(turns[0]).toMatchObject({
      intent: 'park',
      task: 'search/pagination',
      why: 'it is what you are looking at',
    })
  })

  it('uses what just moved when you are not looking at anything', async () => {
    const { voice } = await surface(daemon, {
      events: [
        event('turn_done', 'checkout/refunds', minutesAgo(2)),
        event('turn_done', 'search/pagination', minutesAgo(500)),
      ],
    })
    expect(await voice.handle('park it')).toBe('Parked refunds.')
  })

  it('remembers what you last spoke to', async () => {
    const { voice } = await surface(daemon)
    await voice.handle('tell refunds to also update the docs')
    // No name this time: it should still be refunds.
    expect(await voice.handle('park it')).toBe('Parked refunds.')
  })

  it('narrows by what the verb needs', async () => {
    const tasks = [task('checkout/refunds', 'working'), task('checkout/stripe-v15', 'blocked')]
    const { voice } = await surface(daemon, { tasks })
    // Only one is running, so steering can only mean that one.
    expect(await voice.handle('tell it to hurry up')).toBe('Told refunds.')
    expect(daemon.calls).toEqual(['steer r-refunds to hurry up'])
  })

  describe('when it cannot tell', () => {
    it('asks, rather than picking one', async () => {
      const { voice, turns } = await surface(daemon)
      const reply = await voice.handle('park it')
      expect(reply).toMatch(/^Which one\?/)
      expect(reply).toContain('refunds')
      expect(daemon.calls).toEqual([])
      expect(voice.awaiting?.candidates.length).toBe(3)
      expect(turns[0]?.why).toBe('more than one matches')
    })

    it('carries out the held verb once you pick one', async () => {
      const { voice, turns } = await surface(daemon)
      await voice.handle('park it')
      expect(await voice.handle('the second one')).toBe('Parked stripe-v15.')
      expect(daemon.calls).toEqual(['park /wt/stripe-v15 true'])
      expect(voice.awaiting).toBeNull()
      expect(turns[1]).toMatchObject({ task: 'checkout/stripe-v15', why: 'you picked it' })
    })

    it('takes a name as the answer too', async () => {
      const { voice } = await surface(daemon)
      await voice.handle('park it')
      expect(await voice.handle('pagination')).toBe('Parked pagination.')
    })

    it('drops the question if you say something else entirely', async () => {
      const { voice } = await surface(daemon)
      await voice.handle('park it')
      expect(await voice.handle('where are we')).toBe('All quiet.')
      expect(voice.awaiting).toBeNull()
      expect(daemon.calls).toEqual([])
    })
  })

  it('says so plainly when the name means nothing here', async () => {
    const { voice } = await surface(daemon)
    const reply = await voice.handle('park nonsense')
    // The grammar refuses an unknown name outright, so this is free text.
    expect(reply).toBe("I didn't catch that.")
    expect(daemon.calls).toEqual([])
  })

  it('still takes an explicit name over any inference', async () => {
    const { voice, turns } = await surface(daemon, { focused: 'search/pagination' })
    expect(await voice.handle('park refunds')).toBe('Parked refunds.')
    expect(turns[0]).toMatchObject({ task: 'checkout/refunds', why: 'you said refunds' })
  })
})
