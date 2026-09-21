import { rmSync } from 'node:fs'
import { type Config, type LaneId, speakable } from '@tade/core'
import type { AudioClip, Recording, VoiceSurface, VoiceTerminals } from '@tade/voice-core'
import type { Speaker } from '@tade/voice-tts'
import type { Frame } from '../frame.ts'
import { keyCaps } from '../keys.ts'
import { activeTerminal, notice, setDictation, setListening } from '../model.ts'
import { writeSetting } from '../settings.ts'
import { type Actions, configPathOf, type Subject, type Wiring, why } from './context.ts'

/** A sentence that starts with a capital, because it is read out as one. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

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
  /** The three things a spoken terminal verb asks of the lanes. */
  openTerminal(name: string | null): Promise<string | null>
  showTerminal(id: string): Promise<void>
  openFind(id: string, query: string): Promise<void>
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

export class Voice implements Subject {
  private readonly wire: Wiring
  private readonly deps: VoiceDeps
  /** The voice surface, once `begin` has started one. */
  private surface: VoiceSurface | null = null
  private recording: Recording | null = null
  /** A command voice typed into a terminal, waiting for enter or "confirm". */
  private typed: { id: string; name: string; command: string } | null = null
  private metering: NodeJS.Timeout | null = null

  constructor(wire: Wiring, deps: VoiceDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The key you hold to talk, whether anything can hear you, and whether it is muted. */
  facts(): Partial<Frame> {
    return {
      voice: {
        keys: keyCaps(this.wire.opts.config.surfaces.voice.talk.key),
        available: this.wire.opts.recorder !== undefined,
      },
      muted: this.wire.opts.config.surfaces.voice.muted,
    }
  }

  actions(): Actions {
    return { mute: () => this.toggleMute() }
  }

  /**
   * What voice does with terminals: each answers in the sentence it says back.
   *
   * Here rather than beside the terminals themselves because every one of these
   * is a *spoken* verb — the grammar's, answered in words — and what it asks of
   * a terminal is three things the lanes already do.
   */
  terminals(): VoiceTerminals {
    const project = () => this.wire.state.project ?? undefined
    // Said with no name, it is the terminal in front, or the only one in the project.
    const which = (name: string | null) => {
      const front = activeTerminal(this.wire.state)
      if (!name && front) return this.wire.opts.client.terminal(front.id)
      return this.wire.opts.client.terminal(name, project())
    }
    const attempt = async (act: () => Promise<string>) => {
      try {
        return await act()
      } catch (err) {
        return `${capitalise(why(err))}.`
      }
    }
    return {
      open: (name) =>
        attempt(async () => {
          const opened = await this.deps.openTerminal(name)
          return opened ? `Opened ${opened}.` : 'I could not open a terminal here.'
        }),
      show: (name) =>
        attempt(async () => {
          const terminal = which(name)
          await this.deps.showTerminal(terminal.id)
          return `Showing ${terminal.name}.`
        }),
      close: (name) =>
        attempt(async () => {
          const closed = await this.wire.opts.client.closeTerminal(which(name).id)
          await this.wire.live?.refresh()
          return `Closed ${closed.name}.`
        }),
      rename: (name, to) =>
        attempt(async () => {
          const renamed = await this.wire.opts.client.renameTerminal(which(name).id, to)
          await this.wire.live?.refresh()
          return `Renamed it ${renamed.name}.`
        }),
      run: (name, command) =>
        attempt(async () => {
          const terminal = await this.wire.opts.client.runInTerminal(which(name).id, command, {
            submit: false,
          })
          this.typed = { id: terminal.id, name: terminal.name, command }
          await this.deps.showTerminal(terminal.id)
          return `Typed ${command} into ${terminal.name}. Press enter, or say confirm and the command, to run it.`
        }),
      search: (name, text) =>
        attempt(async () => {
          const { terminal, matches } = await this.wire.opts.client.searchTerminal(
            which(name).id,
            text,
          )
          await this.deps.openFind(terminal.id, text)
          return matches.length === 0
            ? `Nothing in ${terminal.name} says ${text}.`
            : `${matches.length} line${matches.length === 1 ? '' : 's'} in ${terminal.name} mention ${text}.`
        }),
      confirm: async (phrase) => {
        const typed = this.typed
        if (!typed) return null
        const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
        const command = typed.command.toLowerCase()
        if (words.length === 0 || !words.every((word) => command.includes(word))) return null
        this.typed = null
        await this.wire.opts.client.write(typed.id as LaneId, '\r')
        return `Ran ${typed.command} in ${typed.name}.`
      },
    }
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
