import { rmSync } from 'node:fs'
import { type Config, speakable } from '@tade/core'
import type { AudioClip, Recording, VoiceSurface } from '@tade/voice-core'
import type { Speaker } from '@tade/voice-tts'
import { notice, setDictation, setListening } from '../model.ts'
import { writeSetting } from '../settings.ts'
import { configPathOf, type Wiring, why } from './context.ts'

// A voice says words, and this is the window's end of that: the key you hold
// to talk, what is done with what was heard, the mute that is now rather than
// at the end of the sentence, and the three seconds that tell you whether this
// terminal may use the microphone at all.
//
// The surface itself is started in `begin` and handed over — everything it is
// wired to (the orchestrator, the terminals, what the extensions heard) is
// somebody else's, and a subject that assembled it would have to reach for all
// of them.

/** How long one press of push-to-talk may record for. */
const MAX_SPEECH_MS = 120_000

/** How loud counts as having heard you, when the microphone is tested. */
const HEARD_AT = 0.08

/** What this subject needs from the rest of the window. */
export interface VoiceDeps {
  /** Send what is on the orchestrator's line: what a press with no recorder does. */
  submit(): void
  /** Everything addressed to Tade arrives here, however it was said. */
  say(said: string): void
  /** Use a config that has just been written. */
  useConfig(config: Config): void
}

/** The words a general model gets wrong: the task and project names it will hear. */
export function vocabulary(tasks: readonly { task: string }[]): {
  tasks: string[]
  projects: string[]
} {
  const projects = new Set<string>()
  for (const task of tasks) projects.add(task.task.split('/')[0] ?? task.task)
  return { tasks: tasks.map((one) => one.task), projects: [...projects] }
}

/**
 * The head of some Markdown, as it would be said: no emphasis, no code marks,
 * no link targets, and never a fence read out as backticks. One line of it,
 * because what an extension answers is a report and this is its headline.
 */
export function spokenLine(markdown: string): string {
  const [first = ''] = speakable(markdown).split(/(?<=[.!?])\s+/)
  return first
}

export class Voice {
  private readonly wire: Wiring
  private readonly deps: VoiceDeps
  /** The voice surface, once `begin` has started one. */
  private surface: VoiceSurface | null = null
  private recording: Recording | null = null
  private metering: NodeJS.Timeout | null = null

  constructor(wire: Wiring, deps: VoiceDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** Hand it the surface `begin` started. */
  use(surface: VoiceSurface): void {
    this.surface = surface
  }

  /** Whether there is a voice at all: without one, nothing said has anywhere to go. */
  get ready(): boolean {
    return this.surface !== null
  }

  /** What it is waiting to be told, if it asked you something. */
  get awaiting(): VoiceSurface['awaiting'] {
    return this.surface?.awaiting ?? null
  }

  /** Everything addressed to Tade, once it has been written down. */
  handle(said: string): Promise<string> {
    return this.surface?.handle(said) ?? Promise.resolve('')
  }

  /** Say a piece of an answer as it streams. */
  speakChunk(text: string): void {
    this.surface?.speakChunk(text)
  }

  /** Say a whole message, closing off the pieces already said. */
  speakMessage(text: string): void {
    this.surface?.speakMessage(text)
  }

  /** The turn is over: say whatever is still held. */
  flushSpeech(): void {
    this.surface?.flushSpeech()
  }

  /** Cut off what is being said and drop what was queued behind it. */
  silence(): Promise<void> {
    return this.surface?.silence() ?? Promise.resolve()
  }

  /** Stop the surface, on the way out. */
  stop(): Promise<void> {
    return this.surface?.stop() ?? Promise.resolve()
  }

  /**
   * The speaker, as the settings have it now: with spoken replies off, the
   * sounds still play and the words still appear, but nothing is said.
   */
  muteable(speaker: Speaker): Speaker {
    return new Proxy(speaker, {
      get: (target, name, receiver) => {
        const voice = this.wire.opts.config.surfaces.voice
        // Muted is silence: not a word, not a sound.
        if ((name === 'speak' || name === 'earcon') && voice.muted) return async () => {}
        if (name === 'speak' && !voice.speak) return async () => {}
        const value = Reflect.get(target, name, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  /**
   * Push-to-talk. Speech where it is configured and working, the typed line
   * everywhere else — both end up at `say`, so nothing downstream knows or
   * cares which one you used.
   */
  async talkStart(): Promise<void> {
    const recorder = this.wire.opts.recorder
    if (!recorder) {
      this.wire.put(setListening(setDictation(this.wire.state, ''), true))
      this.wire.draw()
      return
    }
    this.wire.put({ ...this.wire.state, talkingSince: this.wire.now() })
    try {
      this.recording = await recorder.start({ maxMs: MAX_SPEECH_MS })
      this.wire.put({ ...setListening(this.wire.state, true), levels: [] })
      this.listenTo(this.recording)
    } catch (err) {
      // Say why, once, then fall back to typing rather than swallowing it.
      this.wire.put(setListening(setDictation(notice(this.wire.state, why(err)), ''), true))
    }
    this.wire.draw()
  }

  async talkStop(): Promise<void> {
    const recording = this.recording
    const transcriber = this.wire.opts.transcriber
    this.recording = null
    this.stopMetering()
    this.wire.put({ ...this.wire.state, levels: [] })
    if (!recording || !transcriber) {
      this.deps.submit()
      return
    }

    this.wire.put({ ...setListening(this.wire.state, false), talkingSince: null, hearing: true })
    this.wire.draw()
    let clip: AudioClip | null = null
    try {
      clip = await recording.stop()
      // Task and project names are the words a general model gets wrong.
      const words = vocabulary(this.wire.live?.tasks ?? [])
      const heard = await transcriber.transcribe(clip, {
        vocabulary: [...words.tasks, ...words.projects],
      })
      this.wire.put({
        ...notice(this.wire.state, heard.text ? null : 'nothing heard'),
        hearing: false,
      })
      this.wire.draw()
      this.deps.say(heard.text)
    } catch (err) {
      this.wire.put({ ...notice(this.wire.state, why(err)), hearing: false, talkingSince: null })
      this.wire.draw()
    } finally {
      if (clip) rmSync(clip.path, { force: true })
    }
  }

  /** Mute everything Tade says and plays, or bring it back; kept for next time. */
  async toggleMute(): Promise<void> {
    const muted = !this.wire.opts.config.surfaces.voice.muted
    try {
      writeSetting(configPathOf(this.wire.opts), 'surfaces.voice.muted', muted ? true : undefined)
    } catch {
      // Not writable: muted for this window only.
    }
    this.deps.useConfig({
      ...this.wire.opts.config,
      surfaces: {
        ...this.wire.opts.config.surfaces,
        voice: { ...this.wire.opts.config.surfaces.voice, muted },
      },
    })
    this.wire.put(
      notice(this.wire.state, muted ? 'muted: nothing will be said or played' : 'sound back on'),
    )
    this.wire.draw()
  }

  /**
   * Listen for three seconds and show what is heard. Nothing is kept: the
   * point is to find out whether this terminal may use the microphone at all,
   * before the first time it matters.
   */
  async testMicrophone(): Promise<void> {
    const recorder = this.wire.opts.recorder
    const finish = (saved: string | null, error: string | null) => {
      const panel = this.wire.state.panel
      if (panel?.kind === 'settings') {
        this.wire.put({ ...this.wire.state, panel: { ...panel, testing: false, saved, error } })
      }
      this.wire.draw()
    }
    if (!recorder) {
      finish(null, 'No recorder is set up. Speech to text needs one: ffmpeg, on most machines.')
      return
    }
    try {
      const recording = await recorder.start({ maxMs: 5_000 })
      this.wire.put({ ...this.wire.state, levels: [] })
      this.listenTo(recording)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      this.stopMetering()
      await recording.cancel()
      const loudest = Math.max(0, ...this.wire.state.levels)
      finish(
        loudest > HEARD_AT ? 'Heard you. The microphone works.' : null,
        loudest > HEARD_AT
          ? null
          : 'Nothing heard. Check that your terminal is allowed to use the microphone.',
      )
    } catch (err) {
      finish(null, why(err))
    }
  }

  /** Sample how loud the microphone is hearing you, for the meter. */
  private listenTo(recording: Recording): void {
    if (!recording.level) return
    this.metering = setInterval(() => {
      const level = recording.level?.() ?? 0
      this.wire.put({ ...this.wire.state, levels: [...this.wire.state.levels, level].slice(-64) })
      this.wire.draw()
    }, 100)
    this.metering.unref?.()
  }

  private stopMetering(): void {
    if (this.metering) clearInterval(this.metering)
    this.metering = null
  }
}
