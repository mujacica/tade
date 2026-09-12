import type { WilcoEvent } from '@wilco/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { Speaker } from '../src/speaker.ts'
import { slugify, type VoiceDaemon, VoiceSurface } from '../src/voice.ts'

// The voice surface with a scripted daemon and a speaker that only records:
// what is under test is which verb a sentence became, and what came back.

const NOW = Date.parse('2026-09-11T14:00:00Z')

function fakeDaemon() {
  const calls: string[] = []
  let handler: ((event: WilcoEvent) => void) | null = null
  const state = {
    pending: [] as Array<{
      run: string
      requestId: string
      task: string
      summary: string
      tier: string
    }>,
    runs: [] as Array<{ run: string; task: string }>,
  }
  const daemon: VoiceDaemon & { calls: string[]; state: typeof state; emit(e: WilcoEvent): void } =
    {
      calls,
      state,
      emit: (event) => handler?.(event),
      async pendingApprovals() {
        return state.pending
      },
      async decideApproval(run, requestId, decision) {
        calls.push(`decide ${run} ${requestId} ${decision.allow ? 'allow' : 'deny'}`)
      },
      async runs() {
        return state.runs
      },
      async steerRun(run, message) {
        calls.push(`steer ${run} ${message}`)
      },
      async parkTask(worktree, parked) {
        calls.push(`park ${worktree} ${parked}`)
        return { task: 'app/migration', parked }
      },
      async createTask(request) {
        calls.push(`create ${request.project}/${request.slug} ${request.intent}`)
        return { id: `${request.project}/${request.slug}`, worktree: `/wt/${request.slug}` }
      },
      async startRun(request) {
        calls.push(`start ${request.task}`)
        return { run: 'r1' }
      },
      async subscribe(fn) {
        handler = fn
        return 'sub-1'
      },
      async unsubscribe(subscription) {
        calls.push(`unsubscribe ${subscription}`)
        handler = null
      },
      async remember(text, scope) {
        calls.push(`remember ${scope ?? '-'} ${text}`)
        return { text, scope, at: new Date(NOW).toISOString() }
      },
    }
  return daemon
}

async function surface(
  daemon: ReturnType<typeof fakeDaemon>,
  over: { ask?: (t: string) => Promise<string> } = {},
) {
  const said: string[] = []
  const tones: string[] = []
  const speaker = await Speaker.create({
    soundDir: tmp('wilco-voice-'),
    platform: 'darwin',
    run: async ({ command, args }) => {
      if (command === 'say') said.push(args.at(-1) ?? '')
      else tones.push(args[0]?.split('/').at(-1) ?? '')
    },
  })
  const voice = await VoiceSurface.start({
    daemon,
    speaker,
    now: () => NOW,
    // Fixed, so quiet hours don't depend on where this machine thinks it is.
    localHour: () => 14,
    vocabulary: async () => ({
      tasks: ['app/migration', 'checkout/refunds'],
      projects: ['app', 'checkout'],
    }),
    status: async (scope) => (scope ? `${scope} is fine.` : 'Two tasks, nothing blocked.'),
    worktreeOf: async (task) => (task === 'app/migration' ? '/wt/migration' : null),
    ...over,
  })
  return { voice, said, tones }
}

const event = (over: Partial<WilcoEvent>): WilcoEvent => ({
  seq: 1,
  ts: '2026-09-11T14:00:00.000Z',
  type: 'permission_request',
  urgency: 'blocking',
  task: 'app/migration',
  lane: null,
  run: 'r1',
  detail: {},
  ...over,
})

describe('VoiceSurface', () => {
  let daemon: ReturnType<typeof fakeDaemon>
  beforeEach(() => {
    daemon = fakeDaemon()
  })

  it('answers where we are', async () => {
    const { voice, said } = await surface(daemon)
    expect(await voice.handle('where are we')).toBe('Two tasks, nothing blocked.')
    expect(said).toEqual(['Two tasks, nothing blocked.'])
  })

  it('lets go of the event stream when it stops', async () => {
    const { voice } = await surface(daemon)
    await voice.stop()
    // Otherwise the daemon keeps pushing events at a surface that has gone.
    expect(daemon.calls).toContain('unsubscribe sub-1')
    daemon.emit(event({}))
    expect(await voice.handle('where are we')).toBe('Two tasks, nothing blocked.')
  })

  it('stops safely even when the daemon has already gone', async () => {
    const { voice } = await surface(daemon)
    daemon.unsubscribe = async () => {
      throw new Error('socket closed')
    }
    await expect(voice.stop()).resolves.toBeUndefined()
  })

  it('parks a task and picks it back up', async () => {
    const { voice } = await surface(daemon)
    expect(await voice.handle('park migration')).toBe('Parked migration.')
    expect(await voice.handle('pick migration back up')).toBe('Picked up migration.')
    expect(daemon.calls).toEqual(['park /wt/migration true', 'park /wt/migration false'])
  })

  it('tells a running agent something', async () => {
    daemon.state.runs = [{ run: 'r7', task: 'checkout/refunds' }]
    const { voice } = await surface(daemon)
    expect(await voice.handle('tell refunds to also update the docs')).toBe('Told refunds.')
    expect(daemon.calls).toEqual(['steer r7 to also update the docs'])
  })

  it('says so when nothing is running on that task', async () => {
    const { voice } = await surface(daemon)
    expect(await voice.handle('tell refunds to hurry up')).toMatch(/Nothing is running/)
    expect(daemon.calls).toEqual([])
  })

  it('starts work, keeping your words as the intent', async () => {
    const { voice } = await surface(daemon)
    const said = await voice.handle('start the refund flow double-charges on retries in checkout')
    expect(said).toMatch(/^Starting /)
    expect(daemon.calls[0]).toContain('create checkout/')
    // The task is named from the words, and the words are kept whole.
    expect(daemon.calls[0]).toContain('the refund flow double-charges on retries')
    expect(daemon.calls[1]).toMatch(/^start checkout\//)
  })

  describe('approvals', () => {
    it('a yes answers the one thing waiting', async () => {
      daemon.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: npm test',
          tier: 'soft',
        },
      ]
      const { voice } = await surface(daemon)
      expect(await voice.handle('go ahead')).toBe('Approved: bash: npm test')
      expect(daemon.calls).toEqual(['decide r1 q1 allow'])
    })

    it('a no denies it, and says what was denied', async () => {
      daemon.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: npm test',
          tier: 'soft',
        },
      ]
      const { voice } = await surface(daemon)
      expect(await voice.handle('no')).toBe('Denied: bash: npm test')
      expect(daemon.calls).toEqual(['decide r1 q1 deny'])
    })

    it('never guesses when more than one thing is waiting', async () => {
      daemon.state.pending = [
        { run: 'r1', requestId: 'q1', task: 'a/b', summary: 'bash: npm test', tier: 'soft' },
        { run: 'r2', requestId: 'q2', task: 'c/d', summary: 'bash: rm -rf build', tier: 'soft' },
      ]
      const { voice } = await surface(daemon)
      expect(await voice.handle('yes')).toMatch(/2 things are waiting/)
      expect(daemon.calls).toEqual([])
    })

    it('a bare yes cannot carry out something destructive', async () => {
      daemon.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: git push --force origin main',
          tier: 'hard',
        },
      ]
      const { voice } = await surface(daemon)
      const reply = await voice.handle('yes')
      expect(reply).toMatch(/needs confirming/)
      expect(reply).toContain('git push --force origin main')
      expect(daemon.calls).toEqual([])
    })

    it('the read-back phrase carries it out', async () => {
      daemon.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: git push --force origin main',
          tier: 'hard',
        },
      ]
      const { voice } = await surface(daemon)
      expect(await voice.handle('confirm force push')).toMatch(/^Confirmed: /)
      expect(daemon.calls).toEqual(['decide r1 q1 allow'])
    })

    it('a phrase that matches nothing does nothing', async () => {
      daemon.state.pending = [
        { run: 'r1', requestId: 'q1', task: 'a/b', summary: 'bash: npm test', tier: 'hard' },
      ]
      const { voice } = await surface(daemon)
      expect(await voice.handle('confirm force push')).toMatch(/Nothing waiting matches/)
      expect(daemon.calls).toEqual([])
    })
  })

  it('passes anything it does not recognise to the orchestrator', async () => {
    const asked: string[] = []
    const { voice } = await surface(daemon, {
      ask: async (text) => {
        asked.push(text)
        return 'It changed the webhook handler.'
      },
    })
    expect(await voice.handle('what did the migration actually change')).toBe(
      'It changed the webhook handler.',
    )
    expect(asked).toEqual(['what did the migration actually change'])
  })

  describe('what it does with events', () => {
    it('speaks something waiting on you', async () => {
      const { voice, said } = await surface(daemon)
      daemon.emit(event({ detail: { summary: 'bash: npm i stripe@15' } }))
      await new Promise((r) => setTimeout(r, 5))
      expect(said[0]).toContain('migration is waiting on bash: npm i stripe@15')
      expect(voice.spokenInLastHour).toBe(1)
    })

    it('plays a tone instead once the hourly budget is gone', async () => {
      const { voice, said, tones } = await surface(daemon)
      for (let i = 0; i < 8; i++) {
        daemon.emit(event({ seq: i, detail: { summary: `thing ${i}` } }))
        await new Promise((r) => setTimeout(r, 2))
      }
      expect(said.length).toBe(6) // the budget
      expect(tones.filter((t) => t === 'blocked.wav').length).toBe(2)

      // Nothing is lost: what was held back comes back as one sentence.
      const summary = await voice.flush()
      expect(summary).toMatch(/^2 things happened\./)
    })

    it('stays quiet about routine noise', async () => {
      const { said, tones } = await surface(daemon)
      daemon.emit(event({ type: 'output', urgency: 'trace' }))
      daemon.emit(event({ type: 'tool_call', urgency: 'routine' }))
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual([])
      expect(tones).toEqual([])
    })

    it('drops to a tone while you are typing in that task', async () => {
      const daemon2 = fakeDaemon()
      const said: string[] = []
      const tones: string[] = []
      const speaker = await Speaker.create({
        soundDir: tmp('wilco-voice-'),
        platform: 'darwin',
        run: async ({ command, args }) => {
          if (command === 'say') said.push(args.at(-1) ?? '')
          else tones.push(args[0]?.split('/').at(-1) ?? '')
        },
      })
      await VoiceSurface.start({
        daemon: daemon2,
        speaker,
        now: () => NOW,
        localHour: () => 14,
        vocabulary: async () => ({ tasks: [], projects: [] }),
        status: async () => '',
        worktreeOf: async () => null,
        focusedTask: () => ({ task: 'app/migration', lastInputAt: NOW - 3_000 }),
      })
      daemon2.emit(event({}))
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual([])
      expect(tones).toEqual(['blocked.wav'])
    })
  })
})

describe('remembering', () => {
  let daemon: ReturnType<typeof fakeDaemon>

  beforeEach(() => {
    daemon = fakeDaemon()
  })

  it('writes it down against whatever you were just talking about', async () => {
    const { voice } = await surface(daemon)
    await voice.handle('show me migration')
    // It says where it filed it, so filing it wrong is obvious and correctable.
    expect(await voice.handle('remember the constraint is on user_id')).toBe(
      'Noted, about migration.',
    )
    expect(daemon.calls).toContain('remember app/migration the constraint is on user_id')
  })

  it('files it against nothing in particular when nothing is being discussed', async () => {
    const { voice } = await surface(daemon)
    expect(await voice.handle('remember I work from home on Fridays')).toBe('Noted.')
    expect(daemon.calls).toContain('remember - I work from home on Fridays')
  })

  it('keeps the wording exactly, like an intent', async () => {
    const { voice } = await surface(daemon)
    await voice.handle('remember the staging key rotates on the 1st')
    expect(daemon.calls).toContain('remember - the staging key rotates on the 1st')
  })

  it('takes a note the other ways of saying it', async () => {
    const { voice } = await surface(daemon)
    await voice.handle('note that the webhook retries twice')
    await voice.handle('keep in mind the index is partial')
    expect(daemon.calls).toContain('remember - the webhook retries twice')
    expect(daemon.calls).toContain('remember - the index is partial')
  })

  it('says plainly when there is nowhere to write it down', async () => {
    // Without a daemon that can store it, saying "noted" would be a lie.
    const { remember: _cannot, ...cannotRemember } = fakeDaemon()
    const { voice } = await surface(cannotRemember)
    expect(await voice.handle('remember anything at all')).toBe("I can't remember things yet.")
  })
})

describe('slugify', () => {
  it('names a task from what you said', () => {
    expect(slugify('the refund flow double-charges on retries')).toBe(
      'the-refund-flow-double-charges',
    )
    expect(slugify('Fix the WEBHOOK!')).toBe('fix-the-webhook')
    expect(slugify('???')).toBe('task')
  })
})
