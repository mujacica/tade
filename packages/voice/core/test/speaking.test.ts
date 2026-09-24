import { REST_ON_SCREEN, type TadeEvent } from '@tade/core'
import { Speaker } from '@tade/voice-tts'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type Turn, VoiceSurface, type VoiceWorkbench } from '../src/voice.ts'

// What comes out of the speaker, and when.
//
// `voice.test.ts` is about which verb a sentence became. This is about the
// other half: a reply arriving faster than a voice can say it, the budget that
// stops a long answer being read out in full, and mute — which is now, or it
// is not mute. Every one of these is a thing you notice instantly when it
// breaks and no other test would catch.

const NOW = Date.parse('2026-09-11T14:00:00Z')

/** A workbench that does nothing: none of it is what these tests are about. */
function quietTade(): VoiceWorkbench & { emit(event: TadeEvent): void } {
  let handler: ((event: TadeEvent) => void) | null = null
  return {
    emit: (event) => handler?.(event),
    async pendingApprovals() {
      return []
    },
    async decideApproval() {},
    async runs() {
      return []
    },
    async steerAgent() {},
    async parkTask() {
      return { task: 'app/migration', parked: true }
    },
    async createTask() {
      return { id: 'app/x', worktree: '/wt/x' }
    },
    async startAgent() {
      return {}
    },
    async subscribe(fn) {
      handler = fn
      return () => {
        handler = null
      }
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/**
 * A voice that holds each sentence open until the test lets it go, which is
 * what a real one does: saying a sentence out loud takes seconds, and every
 * question here is about what happens to the words arriving meanwhile.
 */
async function heldVoice(over: Partial<Parameters<typeof VoiceSurface.start>[0]> = {}) {
  const started: string[] = []
  const finished: string[] = []
  let cut = 0
  let saying: { done: () => void } | null = null

  const speaker = await Speaker.create({
    soundDir: tmp('tade-voice-'),
    platform: 'darwin',
    run: (command, signal) =>
      new Promise<void>((resolve) => {
        if (command.command !== 'say') return resolve()
        const text = command.args.at(-1) ?? ''
        started.push(text)
        saying = {
          done: () => {
            finished.push(text)
            saying = null
            resolve()
          },
        }
        signal?.addEventListener('abort', () => {
          cut += 1
          // Cut off where it is: it never finishes, and never is said later.
          saying = null
          resolve()
        })
      }),
  })

  const tade = quietTade()
  const turns: Turn[] = []
  const voice = await VoiceSurface.start({
    tade,
    speaker,
    now: () => NOW,
    localHour: () => 14,
    vocabulary: async () => ({ tasks: [], projects: [] }),
    status: async () => 'Nothing blocked.',
    worktreeOf: async () => null,
    onTurn: (turn) => turns.push(turn),
    ...over,
  })

  return {
    voice,
    tade,
    started,
    finished,
    turns,
    get cut() {
      return cut
    },
    /** Let the sentence being said finish, so the next one can start. */
    async release(times = 1): Promise<void> {
      for (let i = 0; i < times; i++) {
        saying?.done()
        await tick()
      }
    },
  }
}

describe('a reply arriving faster than it can be said', () => {
  it('says each sentence in turn, never over the one before it', async () => {
    const heard = await heldVoice()
    // Three sentences in one breath, while the first has not finished.
    heard.voice.speakChunk('The retry loop charges twice. It is in the webhook. ')
    heard.voice.speakChunk('Two agents are on it. ')
    await tick()

    // One voice at a time: the rest are queued, not spoken over.
    expect(heard.started).toEqual(['The retry loop charges twice.'])
    await heard.release()
    expect(heard.started).toEqual(['The retry loop charges twice.', 'It is in the webhook.'])
    await heard.release()
    expect(heard.started.at(-1)).toBe('Two agents are on it.')
    await heard.release()
    expect(heard.finished).toEqual([
      'The retry loop charges twice.',
      'It is in the webhook.',
      'Two agents are on it.',
    ])
  })

  it('stops after the budget, however much more arrives', async () => {
    const heard = await heldVoice()
    for (const sentence of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) {
      heard.voice.speakChunk(`${sentence} `)
    }
    await heard.release(8)

    // Three sentences is the most anyone follows down one earbud, and what is
    // cut is on the screen rather than lost.
    expect(heard.started).toEqual(['One.', 'Two.', 'Three.', REST_ON_SCREEN])
  })

  it('says the rest is on screen once, not once per sentence that did not fit', async () => {
    const heard = await heldVoice()
    for (let i = 0; i < 20; i++) heard.voice.speakChunk(`Sentence number ${i}. `)
    await heard.release(10)
    expect(heard.started.filter((said) => said === REST_ON_SCREEN)).toHaveLength(1)
  })

  it('cuts one enormous sentence at a word rather than reading all of it', async () => {
    const heard = await heldVoice()
    // A model that answers in one breath still has to be stoppable: the budget
    // is sentences *and* characters, whichever runs out first.
    const sentence = `It ${'went on and on '.repeat(40)}forever.`
    heard.voice.speakChunk(`${sentence} `)
    await heard.release(2)

    const said = heard.started[0] ?? ''
    expect(said.endsWith(REST_ON_SCREEN)).toBe(true)
    expect(said.length).toBeLessThan(400)

    // What was said is the front of the sentence, cut where a word ends —
    // stopping dead in the middle of one is worse than trailing off.
    const head = said.slice(0, -REST_ON_SCREEN.length).trimEnd()
    expect(sentence.startsWith(head)).toBe(true)
    expect(head.length).toBeGreaterThan(0)
    expect(sentence.slice(head.length, head.length + 1)).toBe(' ')
  })

  it('never reads out half a fence, however it is split across chunks', async () => {
    const heard = await heldVoice()
    // A code block arriving a few characters at a time, as a model streams it.
    for (const chunk of ['Here it is. ', '```', 'ts\nconst x', ' = 1\n', '```', '\nThat is it. ']) {
      heard.voice.speakChunk(chunk)
    }
    await heard.release(4)
    expect(heard.started).toEqual(['Here it is.', 'That is it.'])
  })

  it('drops a fence the answer ended in the middle of', async () => {
    const heard = await heldVoice()
    heard.voice.speakChunk('The stack trace is:\n```\nTypeError: x is not a function\n')
    // The turn ended without the model closing it — half a fence is exactly
    // the "backtick backtick backtick" nobody wants read out.
    heard.voice.flushSpeech()
    await heard.release(2)
    expect(heard.started).toEqual(['The stack trace is:'])
  })
})

describe('mute is now', () => {
  it('cuts the sentence being said and drops everything queued behind it', async () => {
    const heard = await heldVoice()
    heard.voice.speakChunk('The first sentence. The second. The third. ')
    await tick()
    expect(heard.started).toEqual(['The first sentence.'])

    await heard.voice.silence()
    expect(heard.cut).toBe(1)

    // Nothing finished, and what was behind it never starts — not now, and
    // not in a moment when whatever made you reach for mute has passed.
    await tick()
    await heard.release(3)
    expect(heard.finished).toEqual([])
    expect(heard.started).toEqual(['The first sentence.'])
  })

  it('drops a long queue, not just the one sentence in front', async () => {
    const heard = await heldVoice()
    for (let i = 0; i < 12; i++) heard.voice.speakChunk(`Sentence ${i}. `)
    await tick()
    expect(heard.started).toHaveLength(1)

    await heard.voice.silence()
    await heard.release(12)
    // The budget would have allowed three; mute allowed none of them.
    expect(heard.started).toHaveLength(1)
    expect(heard.finished).toEqual([])
  })

  it('is harmless when nothing is being said', async () => {
    const heard = await heldVoice()
    await expect(heard.voice.silence()).resolves.toBeUndefined()
    await expect(heard.voice.silence()).resolves.toBeUndefined()
    expect(heard.started).toEqual([])
  })

  it('leaves the next thing said perfectly normal', async () => {
    const heard = await heldVoice()
    heard.voice.speakChunk('Dropped. ')
    // Let it actually start, so this is a sentence cut off rather than one
    // dropped in the queue before it was ever reached — both happen, and the
    // test above is about the other one.
    await tick()
    await heard.voice.silence()

    heard.voice.speakChunk('Said afterwards. ')
    await heard.release(2)
    expect(heard.started).toEqual(['Dropped.', 'Said afterwards.'])
    expect(heard.finished).toEqual(['Said afterwards.'])
  })

  it('does not let a half-said answer leak into the next one', async () => {
    const heard = await heldVoice()
    // Silenced part-way through a sentence that had not ended yet.
    heard.voice.speakChunk('This sentence never ends')
    await heard.voice.silence()
    heard.voice.flushSpeech()
    await heard.release(2)
    expect(heard.started).toEqual([])
  })
})

describe('where there is no voice at all', () => {
  it('says nothing and answers anyway, rather than failing', async () => {
    // A machine with no speech: the words still reach the screen.
    const speaker = await Speaker.create({
      soundDir: tmp('tade-voice-'),
      platform: 'win32',
      run: async () => {
        throw new Error('this machine has no audio and should never be asked')
      },
    })
    expect(speaker.capabilities).toEqual({ speech: false, sound: false })

    const turns: Turn[] = []
    const voice = await VoiceSurface.start({
      tade: quietTade(),
      speaker,
      now: () => NOW,
      localHour: () => 14,
      vocabulary: async () => ({ tasks: [], projects: [] }),
      status: async () => 'Two tasks, nothing blocked.',
      worktreeOf: async () => null,
      onTurn: (turn) => turns.push(turn),
    })

    expect(await voice.handle('where are we')).toBe('Two tasks, nothing blocked.')
    // And nothing was reported as having gone wrong, because nothing did.
    expect(turns.map((turn) => turn.reply)).toEqual(['Two tasks, nothing blocked.'])
    await expect(voice.silence()).resolves.toBeUndefined()
  })

  it('reports a voice that broke, rather than going quiet about it', async () => {
    const turns: Turn[] = []
    const voice = await VoiceSurface.start({
      tade: quietTade(),
      speaker: {
        capabilities: { speech: true, sound: false },
        speak: async () => {
          throw new Error('audio device busy')
        },
        earcon: async () => {},
        stop: async () => {},
      } as unknown as Parameters<typeof VoiceSurface.start>[0]['speaker'],
      now: () => NOW,
      localHour: () => 14,
      vocabulary: async () => ({ tasks: [], projects: [] }),
      status: async () => 'Nothing blocked.',
      worktreeOf: async () => null,
      onTurn: (turn) => turns.push(turn),
    })

    await voice.handle('where are we')
    await tick()
    // A conversation that goes quiet is the worst failure it has: it looks
    // exactly like thinking.
    expect(turns.map((turn) => turn.reply)).toContain('Speech failed: audio device busy')
  })

  it('a mute that itself fails is still a mute', async () => {
    const voice = await VoiceSurface.start({
      tade: quietTade(),
      speaker: {
        capabilities: { speech: true, sound: false },
        speak: async () => {},
        earcon: async () => {},
        stop: async () => {
          throw new Error('spd-say: cannot reach speech-dispatcher')
        },
      } as unknown as Parameters<typeof VoiceSurface.start>[0]['speaker'],
      now: () => NOW,
      localHour: () => 14,
      vocabulary: async () => ({ tasks: [], projects: [] }),
      status: async () => 'Nothing blocked.',
      worktreeOf: async () => null,
    })
    // The queue is dropped whatever the speaker says about being stopped: the
    // half that is Tade's own must not depend on the half that is not.
    await expect(voice.silence()).rejects.toThrow(/speech-dispatcher/)
    voice.speakChunk('Said afterwards. ')
    await tick()
  })
})
