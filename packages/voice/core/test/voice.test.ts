import { REST_ON_SCREEN, type TadeEvent } from '@tade/core'
import { Speaker } from '@tade/voice-tts'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import {
  slugify,
  type Turn,
  VoiceSurface,
  type VoiceTerminals,
  type VoiceWorkbench,
} from '../src/voice.ts'

// The voice surface with a scripted workbench and a speaker that only records:
// what is under test is which verb a sentence became, and what came back.

const NOW = Date.parse('2026-09-11T14:00:00Z')

function fakeTade() {
  const calls: string[] = []
  let handler: ((event: TadeEvent) => void) | null = null
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
  const decisions: Array<{ allow: boolean; reason?: string; said?: string }> = []
  const tade: VoiceWorkbench & {
    calls: string[]
    decisions: typeof decisions
    state: typeof state
    emit(e: TadeEvent): void
  } = {
    calls,
    decisions,
    state,
    emit: (event) => handler?.(event),
    async pendingApprovals() {
      return state.pending
    },
    async decideApproval(run, requestId, decision) {
      calls.push(`decide ${run} ${requestId} ${decision.allow ? 'allow' : 'deny'}`)
      decisions.push(decision)
    },
    async runs() {
      return state.runs
    },
    async steerAgent(task, message) {
      calls.push(`steer ${task} ${message}`)
    },
    async parkTask(task, parked) {
      calls.push(`park ${task} ${parked}`)
      return { task: 'app/migration', parked }
    },
    async createTask(request) {
      calls.push(`create ${request.project}/${request.slug} ${request.intent}`)
      return { id: `${request.project}/${request.slug}`, worktree: `/wt/${request.slug}` }
    },
    async startAgent(request) {
      calls.push(`start ${request.task}`)
      return { run: 'r1' }
    },
    async subscribe(fn) {
      handler = fn
      return () => {
        calls.push('unsubscribed')
        handler = null
      }
    },
    async remember(text, scope) {
      calls.push(`remember ${scope ?? '-'} ${text}`)
      return { text, scope, at: new Date(NOW).toISOString() }
    },
  }
  return tade
}

async function surface(
  tade: ReturnType<typeof fakeTade>,
  over: {
    ask?: (t: string) => Promise<string>
    extension?: (t: string) => Promise<string | null>
    terminals?: VoiceTerminals
  } = {},
) {
  const said: string[] = []
  const tones: string[] = []
  const speaker = await Speaker.create({
    soundDir: tmp('tade-voice-'),
    platform: 'darwin',
    run: async ({ command, args }) => {
      if (command === 'say') said.push(args.at(-1) ?? '')
      else tones.push(args[0]?.split('/').at(-1) ?? '')
    },
  })
  const voice = await VoiceSurface.start({
    tade,
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

const event = (over: Partial<TadeEvent>): TadeEvent => ({
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
  let tade: ReturnType<typeof fakeTade>
  beforeEach(() => {
    tade = fakeTade()
  })

  it('answers where we are', async () => {
    const { voice, said } = await surface(tade)
    expect(await voice.handle('where are we')).toBe('Two tasks, nothing blocked.')
    expect(said).toEqual(['Two tasks, nothing blocked.'])
  })

  it('lets go of the event stream when it stops', async () => {
    const { voice } = await surface(tade)
    await voice.stop()
    // Otherwise the journal keeps pushing events at a surface that has gone.
    expect(tade.calls).toContain('unsubscribed')
    tade.emit(event({}))
    expect(await voice.handle('where are we')).toBe('Two tasks, nothing blocked.')
  })

  it('stops twice without complaining', async () => {
    const { voice } = await surface(tade)
    await voice.stop()
    // Whoever is closing the window may well ask twice.
    await expect(voice.stop()).resolves.toBeUndefined()
  })

  it('parks a task and picks it back up', async () => {
    const { voice } = await surface(tade)
    expect(await voice.handle('park migration')).toBe('Parked migration.')
    expect(await voice.handle('pick migration back up')).toBe('Picked up migration.')
    expect(tade.calls).toEqual(['park app/migration true', 'park app/migration false'])
  })

  it('tells a running agent something', async () => {
    tade.state.runs = [{ run: 'r7', task: 'checkout/refunds' }]
    const { voice } = await surface(tade)
    expect(await voice.handle('tell refunds to also update the docs')).toBe('Told refunds.')
    expect(tade.calls).toEqual(['steer checkout/refunds to also update the docs'])
  })

  it('says so when nothing is running on that task', async () => {
    const { voice } = await surface(tade)
    expect(await voice.handle('tell refunds to hurry up')).toMatch(/Nothing is running/)
    expect(tade.calls).toEqual([])
  })

  it('starts work, keeping your words as the intent', async () => {
    const { voice } = await surface(tade)
    const said = await voice.handle('start the refund flow double-charges on retries in checkout')
    expect(said).toMatch(/^Starting /)
    expect(tade.calls[0]).toContain('create checkout/')
    // The task is named from the words, and the words are kept whole.
    expect(tade.calls[0]).toContain('the refund flow double-charges on retries')
    expect(tade.calls[1]).toMatch(/^start checkout\//)
  })

  describe('approvals', () => {
    it('a yes answers the one thing waiting', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: npm test',
          tier: 'soft',
        },
      ]
      const { voice } = await surface(tade)
      expect(await voice.handle('go ahead')).toBe('Approved: bash: npm test')
      expect(tade.calls).toEqual(['decide r1 q1 allow'])
    })

    it('a no denies it, and says what was denied', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: npm test',
          tier: 'soft',
        },
      ]
      const { voice } = await surface(tade)
      expect(await voice.handle('no')).toBe('Denied: bash: npm test')
      expect(tade.calls).toEqual(['decide r1 q1 deny'])
    })

    it('never guesses when more than one thing is waiting', async () => {
      tade.state.pending = [
        { run: 'r1', requestId: 'q1', task: 'a/b', summary: 'bash: npm test', tier: 'soft' },
        { run: 'r2', requestId: 'q2', task: 'c/d', summary: 'bash: rm -rf build', tier: 'soft' },
      ]
      const { voice } = await surface(tade)
      expect(await voice.handle('yes')).toMatch(/2 things are waiting/)
      expect(tade.calls).toEqual([])
    })

    it('records the words that decided it, verbatim', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: npm test',
          tier: 'soft',
        },
      ]
      const { voice } = await surface(tade)
      await voice.handle('no')
      // The ledger keeps what you said, so a decision can be explained later
      // in the words that made it.
      expect(tade.decisions.at(-1)).toMatchObject({ allow: false, said: 'no' })
    })

    it('records the confirming phrase too', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: git push --force origin main',
          tier: 'hard',
        },
      ]
      const { voice } = await surface(tade)
      await voice.handle('confirm force push')
      expect(tade.decisions.at(-1)).toMatchObject({ allow: true, said: 'confirm force push' })
    })

    it('a bare yes cannot carry out something destructive', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: git push --force origin main',
          tier: 'hard',
        },
      ]
      const { voice } = await surface(tade)
      const reply = await voice.handle('yes')
      expect(reply).toMatch(/needs confirming/)
      expect(reply).toContain('git push --force origin main')
      expect(tade.calls).toEqual([])
    })

    it('the read-back phrase carries it out', async () => {
      tade.state.pending = [
        {
          run: 'r1',
          requestId: 'q1',
          task: 'app/migration',
          summary: 'bash: git push --force origin main',
          tier: 'hard',
        },
      ]
      const { voice } = await surface(tade)
      expect(await voice.handle('confirm force push')).toMatch(/^Confirmed: /)
      expect(tade.calls).toEqual(['decide r1 q1 allow'])
    })

    it('a phrase that matches nothing does nothing', async () => {
      tade.state.pending = [
        { run: 'r1', requestId: 'q1', task: 'a/b', summary: 'bash: npm test', tier: 'hard' },
      ]
      const { voice } = await surface(tade)
      expect(await voice.handle('confirm force push')).toMatch(/Nothing waiting matches/)
      expect(tade.calls).toEqual([])
    })
  })

  it('passes anything it does not recognise to the orchestrator', async () => {
    const asked: string[] = []
    const { voice } = await surface(tade, {
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

  it('lets an extension answer what it listens for before the orchestrator is asked', async () => {
    const asked: string[] = []
    const { voice } = await surface(tade, {
      extension: async (text) =>
        text === 'how much is tade using' ? 'Tade is using 12% CPU and 400 MB of memory.' : null,
      ask: async (text) => {
        asked.push(text)
        return 'Asked.'
      },
    })
    expect(await voice.handle('how much is tade using')).toBe(
      'Tade is using 12% CPU and 400 MB of memory.',
    )
    expect(await voice.handle('what did the migration change')).toBe('Asked.')
    expect(asked).toEqual(['what did the migration change'])
  })

  describe('what it does with events', () => {
    it('speaks something waiting on you', async () => {
      const { voice, said } = await surface(tade)
      tade.emit(event({ detail: { summary: 'bash: npm i stripe@15' } }))
      await new Promise((r) => setTimeout(r, 5))
      expect(said[0]).toContain('migration is waiting on bash: npm i stripe@15')
      expect(voice.spokenInLastHour).toBe(1)
    })

    it('plays a tone instead once the hourly budget is gone', async () => {
      const { voice, said, tones } = await surface(tade)
      for (let i = 0; i < 8; i++) {
        tade.emit(event({ seq: i, detail: { summary: `thing ${i}` } }))
        await new Promise((r) => setTimeout(r, 2))
      }
      expect(said.length).toBe(6) // the budget
      expect(tones.filter((t) => t === 'blocked.wav').length).toBe(2)

      // Nothing is lost: what was held back comes back as one sentence.
      const summary = await voice.flush()
      expect(summary).toMatch(/^2 things happened\./)
    })

    it('stays quiet about routine noise', async () => {
      const { said, tones } = await surface(tade)
      tade.emit(event({ type: 'output', urgency: 'trace' }))
      tade.emit(event({ type: 'tool_call', urgency: 'routine' }))
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual([])
      expect(tones).toEqual([])
    })

    it('drops to a tone while you are typing in that task', async () => {
      const second = fakeTade()
      const said: string[] = []
      const tones: string[] = []
      const speaker = await Speaker.create({
        soundDir: tmp('tade-voice-'),
        platform: 'darwin',
        run: async ({ command, args }) => {
          if (command === 'say') said.push(args.at(-1) ?? '')
          else tones.push(args[0]?.split('/').at(-1) ?? '')
        },
      })
      await VoiceSurface.start({
        tade: second,
        speaker,
        now: () => NOW,
        localHour: () => 14,
        vocabulary: async () => ({ tasks: [], projects: [] }),
        status: async () => '',
        worktreeOf: async () => null,
        focusedTask: () => ({ task: 'app/migration', lastInputAt: NOW - 3_000 }),
      })
      second.emit(event({}))
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual([])
      expect(tones).toEqual(['blocked.wav'])
    })
  })

  describe('going quiet', () => {
    it('cuts off what it is saying and drops what was queued', async () => {
      const started: string[] = []
      const finished: string[] = []
      let cut = 0
      const speaker = await Speaker.create({
        soundDir: tmp('tade-voice-'),
        platform: 'darwin',
        run: (command, signal) =>
          new Promise<void>((resolve) => {
            if (command.command !== 'say') return resolve()
            const text = command.args.at(-1) ?? ''
            started.push(text)
            // A sentence takes seconds to say out loud.
            const done = setTimeout(() => {
              finished.push(text)
              resolve()
            }, 2_000)
            signal?.addEventListener('abort', () => {
              cut += 1
              clearTimeout(done)
              resolve()
            })
          }),
      })
      const voice = await VoiceSurface.start({
        tade,
        speaker,
        now: () => NOW,
        localHour: () => 14,
        vocabulary: async () => ({ tasks: [], projects: [] }),
        status: async () => '',
        worktreeOf: async () => null,
      })
      voice.speakChunk('The first sentence. Then the second. ')
      await new Promise((r) => setTimeout(r, 5))
      expect(started).toEqual(['The first sentence.'])

      await voice.silence()
      expect(cut).toBe(1)
      // Nothing finished, and what was behind it never starts.
      await new Promise((r) => setTimeout(r, 20))
      expect(finished).toEqual([])
      expect(started).toEqual(['The first sentence.'])
    })

    it('says what comes after it was silenced', async () => {
      const { voice, said } = await surface(tade)
      voice.speakChunk('Dropped. ')
      await voice.silence()
      voice.speakChunk('Said. ')
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual(['Said.'])
    })
  })

  describe('streaming speech', () => {
    it('speaks sentences as chunks arrive, not all at the end', async () => {
      const { voice, said } = await surface(tade)
      voice.speakChunk('First sentence. ')
      voice.speakChunk('Second sentence. ')
      voice.speakChunk('Third')
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual(['First sentence.', 'Second sentence.'])
      voice.flushSpeech()
      await new Promise((r) => setTimeout(r, 5))
      expect(said).toEqual(['First sentence.', 'Second sentence.', 'Third'])
    })

    it('reports a speech failure rather than going quiet', async () => {
      const turns: Turn[] = []
      const brokenSpeaker = {
        capabilities: { speech: true, sound: false },
        speak: async () => {
          throw new Error('audio device busy')
        },
        earcon: async () => {},
        toneFile: () => '',
      } as unknown as Speaker
      const voice = await VoiceSurface.start({
        tade,
        speaker: brokenSpeaker,
        now: () => NOW,
        localHour: () => 14,
        vocabulary: async () => ({ tasks: [], projects: [] }),
        status: async () => '',
        worktreeOf: async () => null,
        onTurn: (turn) => turns.push(turn),
      })
      voice.speakChunk('Say this.')
      await new Promise((r) => setTimeout(r, 5))
      voice.flushSpeech()
      await new Promise((r) => setTimeout(r, 5))
      expect(turns.some((t) => t.reply.includes('Speech failed'))).toBe(true)
    })

    // How the orchestrator's answer arrives: in pieces, then as one message,
    // then as the reply to what was asked. Each of the three was once said.
    const ANSWER = 'Refunds has an agent on it now. Which opus: 4.1, 4.6 or 5?'
    const answering = (voice: () => VoiceSurface) => async () => {
      voice().speakChunk('Refunds has an agent ')
      voice().speakChunk('on it now. Which opus: 4.1, ')
      voice().speakChunk('4.6 or 5?')
      voice().speakMessage(ANSWER)
      return ANSWER
    }

    it('says an answer once, however many ways it arrives', async () => {
      let voice: VoiceSurface | null = null
      const made = await surface(tade, { ask: answering(() => voice as VoiceSurface) })
      voice = made.voice
      expect(await made.voice.handle('what about the refunds design')).toBe(ANSWER)
      expect(made.said).toEqual(['Refunds has an agent on it now.', 'Which opus: 4.1, 4.6 or 5?'])
    })

    it('says a message that did not stream, once', async () => {
      let voice: VoiceSurface | null = null
      const made = await surface(tade, {
        ask: async () => {
          voice?.speakMessage(ANSWER)
          return ANSWER
        },
      })
      voice = made.voice
      await made.voice.handle('what about the refunds design')
      expect(made.said).toEqual([ANSWER])
    })

    it('says the finding, never the fences around it', async () => {
      let voice: VoiceSurface | null = null
      const answer = [
        'The retry loop charges twice.',
        '',
        '```ts',
        'for (const attempt of attempts) await charge(attempt)',
        '```',
        '',
        'It is in packages/app/src/webhook.ts.',
      ].join('\n')
      const made = await surface(tade, {
        ask: async () => {
          voice?.speakChunk(answer)
          voice?.speakMessage(answer)
          return answer
        },
      })
      voice = made.voice
      await made.voice.handle('what did you find in refunds')
      await new Promise((r) => setTimeout(r, 5))
      // The whole answer is on the screen; what is said is its words.
      expect(made.said).toEqual(['The retry loop charges twice.', 'It is in webhook.ts.'])
      expect(made.said.join(' ')).not.toContain('`')
    })

    it('says the first of a long answer and leaves the rest on the screen', async () => {
      let voice: VoiceSurface | null = null
      const sentences = [
        'The retry loop charges twice.',
        'It is in the webhook handler.',
        'Two agents are on it.',
        'The first has a branch already.',
        'I can start a third.',
      ]
      const made = await surface(tade, {
        ask: async () => {
          for (const sentence of sentences) voice?.speakChunk(`${sentence} `)
          voice?.speakMessage(sentences.join(' '))
          return sentences.join(' ')
        },
      })
      voice = made.voice
      await made.voice.handle('what did you find in refunds')
      await new Promise((r) => setTimeout(r, 5))
      expect(made.said).toEqual([...sentences.slice(0, 3), REST_ON_SCREEN])
    })

    it('a new answer gets the whole of the limit again', async () => {
      let voice: VoiceSurface | null = null
      const made = await surface(tade, {
        ask: async () => {
          voice?.speakChunk('One. Two. Three. Four. ')
          voice?.speakMessage('One. Two. Three. Four.')
          return 'One. Two. Three. Four.'
        },
      })
      voice = made.voice
      await made.voice.handle('what about the refunds design')
      await made.voice.handle('what about the refunds design')
      await new Promise((r) => setTimeout(r, 5))
      expect(made.said.filter((s) => s === 'One.').length).toBe(2)
    })

    it('a whole answer that never streamed is summarised too', async () => {
      let voice: VoiceSurface | null = null
      const answer = 'One. Two. Three. Four. Five.'
      const made = await surface(tade, {
        ask: async () => {
          voice?.speakMessage(answer)
          return answer
        },
      })
      voice = made.voice
      await made.voice.handle('what about the refunds design')
      await new Promise((r) => setTimeout(r, 5))
      expect(made.said).toEqual([`One. Two. Three. ${REST_ON_SCREEN}`])
    })

    it('never talks over itself', async () => {
      const said: string[] = []
      let talking = 0
      let most = 0
      const speaker = await Speaker.create({
        soundDir: tmp('tade-voice-'),
        platform: 'darwin',
        run: async ({ command, args }) => {
          if (command !== 'say') return
          talking++
          most = Math.max(most, talking)
          await new Promise((r) => setTimeout(r, 15))
          said.push(args.at(-1) ?? '')
          talking--
        },
      })
      let voice: VoiceSurface | null = null
      voice = await VoiceSurface.start({
        tade,
        speaker,
        now: () => NOW,
        localHour: () => 14,
        vocabulary: async () => ({ tasks: ['app/migration'], projects: ['app'] }),
        status: async () => '',
        worktreeOf: async () => null,
        ask: answering(() => voice as VoiceSurface),
      })
      const answered = voice.handle('what about the refunds design')
      // Something that wants you, while the answer is still being said.
      tade.emit(event({ type: 'permission_request', urgency: 'blocking' }))
      await answered
      await new Promise((r) => setTimeout(r, 60))
      expect(most).toBe(1)
      // Everything said, each once, in whichever order it came.
      expect([...said].sort()).toEqual([
        'Refunds has an agent on it now.',
        'Which opus: 4.1, 4.6 or 5?',
        'migration is waiting on a decision',
      ])
    })
  })
})

describe('remembering', () => {
  let tade: ReturnType<typeof fakeTade>

  beforeEach(() => {
    tade = fakeTade()
  })

  it('writes it down against whatever you were just talking about', async () => {
    const { voice } = await surface(tade)
    await voice.handle('show me migration')
    // It says where it filed it, so filing it wrong is obvious and correctable.
    expect(await voice.handle('remember the constraint is on user_id')).toBe(
      'Noted, about migration.',
    )
    expect(tade.calls).toContain('remember app/migration the constraint is on user_id')
  })

  it('files it against nothing in particular when nothing is being discussed', async () => {
    const { voice } = await surface(tade)
    expect(await voice.handle('remember I work from home on Fridays')).toBe('Noted.')
    expect(tade.calls).toContain('remember - I work from home on Fridays')
  })

  it('keeps the wording exactly, like an intent', async () => {
    const { voice } = await surface(tade)
    await voice.handle('remember the staging key rotates on the 1st')
    expect(tade.calls).toContain('remember - the staging key rotates on the 1st')
  })

  it('takes a note the other ways of saying it', async () => {
    const { voice } = await surface(tade)
    await voice.handle('note that the webhook retries twice')
    await voice.handle('keep in mind the index is partial')
    expect(tade.calls).toContain('remember - the webhook retries twice')
    expect(tade.calls).toContain('remember - the index is partial')
  })

  it('says plainly when there is nowhere to write it down', async () => {
    // Without somewhere to store it, saying "noted" would be a lie.
    const { remember: _cannot, ...cannotRemember } = fakeTade()
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

describe('terminals, by voice', () => {
  function terminals() {
    const calls: string[] = []
    let typed: string | null = null
    const control: VoiceTerminals = {
      open: async (name) => {
        calls.push(`open ${name ?? '-'}`)
        return `Opened ${name ?? 'terminal 1'}.`
      },
      show: async (name) => `Showing ${name ?? '-'}.`,
      close: async (name) => `Closed ${name ?? '-'}.`,
      rename: async (name, to) => `Renamed ${name ?? '-'} to ${to}.`,
      run: async (name, command) => {
        typed = command
        calls.push(`type ${name ?? '-'} ${command}`)
        return `Typed ${command}.`
      },
      search: async (name, text) => `Looked for ${text} in ${name ?? '-'}.`,
      confirm: async (phrase) => {
        if (!typed || !phrase.split(' ').every((word) => typed?.includes(word))) return null
        calls.push(`enter ${typed}`)
        typed = null
        return 'Ran it.'
      },
    }
    return { control, calls }
  }

  it('opens, shows, renames, closes and searches the terminal it names', async () => {
    const { control, calls } = terminals()
    const { voice } = await surface(fakeTade(), { terminals: control })
    expect(await voice.handle('open a new terminal called tests')).toBe('Opened tests.')
    expect(await voice.handle('show me the tests terminal')).toBe('Showing tests.')
    expect(await voice.handle('rename terminal 2 to server')).toBe('Renamed 2 to server.')
    expect(await voice.handle('find TypeError in the tests terminal')).toBe(
      'Looked for TypeError in tests.',
    )
    expect(await voice.handle('close the server terminal')).toBe('Closed server.')
    expect(calls).toEqual(['open tests'])
  })

  it('types a command it heard, and runs it only once its words are read back', async () => {
    const tade = fakeTade()
    const { control, calls } = terminals()
    const { voice } = await surface(tade, { terminals: control })
    expect(await voice.handle('run npm test in the tests terminal')).toBe('Typed npm test.')
    // A bare yes never runs a command: it could be anything, misheard.
    expect(await voice.handle('yes')).toBe('Nothing is waiting.')
    expect(calls).toEqual(['type tests npm test'])
    expect(await voice.handle('confirm npm test')).toBe('Ran it.')
    expect(calls.at(-1)).toBe('enter npm test')
  })

  it('says so where there are no terminals to control', async () => {
    const { voice } = await surface(fakeTade())
    expect(await voice.handle('open a terminal')).toContain('no terminals here')
  })
})
