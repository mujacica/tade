import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AudioClip, Recorder, Transcriber } from './port.ts'

// The shared suites for the two ports here, `Transcriber` and `Recorder`.
// Like the driver suite, each exists before the second implementation does.
//
// They deliberately assert nothing about accuracy or about loudness: what a
// model hears is not a contract, and a test that asserts on transcribed words
// is a test that fails when someone changes model. What they assert is the
// contract around the engine and the microphone — that each says whether it
// can run *before* you speak, that silence is not an error, that a cancelled
// recording does not turn into text, and that the caller is handed a clip it
// really owns.
//
// **Exercising an implementation must never reach the machine the suite runs
// on.** A real recorder opens a microphone and a real local engine spends a
// minute on a model, and both of those are refused outright by
// `test/no-gui.ts`. So the caller declares which it is handing over
// (`reachesTheMachine`), and one that does is held only to the half of the
// contract that can be checked without doing it: what it says about itself,
// and how it refuses. The other half is reached by handing the same
// implementation its own seam — `FfmpegRecorder`'s `spawn`,
// `WhisperCppTranscriber`'s `run` — which is a stronger test than skipping,
// because it is the real class either way.

export interface SuiteOptions {
  /**
   * Whether exercising this one really opens a device, runs a model or reaches
   * the network. Default false, which is what a scripted implementation and
   * one given a seam of its own both are.
   */
  reachesTheMachine?: boolean
}

/** A WAV file with nothing in it, at the size and rate speech models expect. */
export function silentClip(ms = 400, sampleRate = 16_000): AudioClip {
  const samples = Math.floor((sampleRate * ms) / 1000)
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + samples * 2, 4)
  data.write('WAVE', 8)
  data.write('fmt ', 12)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20) // PCM
  data.writeUInt16LE(1, 22) // mono
  data.writeUInt32LE(sampleRate, 24)
  data.writeUInt32LE(sampleRate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  const path = join(
    tmpdir(),
    `tade-silent-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
  )
  writeFileSync(path, data)
  return { path, sampleRate, durationMs: ms }
}

export function testTranscriber(
  name: string,
  make: () => Transcriber | Promise<Transcriber>,
  opts: SuiteOptions = {},
): void {
  const reaches = opts.reachesTheMachine ?? false
  /** Whether this one can actually be asked to transcribe something here. */
  const usable = async (transcriber: Transcriber) => !reaches && (await transcriber.available()).ok

  describe(`Transcriber: ${name}`, () => {
    it('declares an id and a full capability set', async () => {
      const transcriber = await make()
      expect(transcriber.id).toBeTruthy()
      for (const key of ['local', 'streaming', 'vocabulary'] as const) {
        expect(typeof transcriber.capabilities[key]).toBe('boolean')
      }
    })

    it('says whether it can run, rather than throwing', async () => {
      const transcriber = await make()
      // Asked before anything is recorded, so a missing model is a sentence
      // and not a failure after the user has already spoken.
      const availability = await transcriber.available()
      expect(typeof availability.ok).toBe('boolean')
      if (!availability.ok) expect(availability.reason).toBeTruthy()
    })

    it('refuses clearly when it cannot run', async () => {
      const transcriber = await make()
      if ((await transcriber.available()).ok) return
      await expect(transcriber.transcribe(silentClip())).rejects.toThrow(/unavailable/)
    })

    it('treats silence as nothing said, not as an error', async () => {
      const transcriber = await make()
      if (!(await usable(transcriber))) return
      const transcript = await transcriber.transcribe(silentClip())
      expect(typeof transcript.text).toBe('string')
      expect(transcript.by).toBe(transcriber.id)
    })

    it('gives up when the caller does', async () => {
      const transcriber = await make()
      if (!(await usable(transcriber))) return
      const controller = new AbortController()
      controller.abort()
      await expect(
        transcriber.transcribe(silentClip(), { signal: controller.signal }),
      ).rejects.toThrow()
    })
  })
}

/**
 * The shared suite every Recorder must pass.
 *
 * A recording is a small state machine with hardware at the other end, and
 * every part of what it promises is about the awkward half: that it says it
 * cannot run *before* you have spoken rather than after, that stopping hands
 * back a clip the caller really owns and can delete, and that cancelling
 * leaves nothing behind. Nothing here asserts that anything was *heard* —
 * whether a microphone picked up a voice is not a contract, and a suite that
 * asserted it could only pass on a machine with somebody talking into it.
 */
export function testRecorder(
  name: string,
  make: () => Recorder | Promise<Recorder>,
  opts: SuiteOptions = {},
): void {
  const reaches = opts.reachesTheMachine ?? false
  /** Whether a recording can actually be started here without opening a device. */
  const usable = async (recorder: Recorder) => !reaches && (await recorder.available()).ok

  describe(`Recorder: ${name}`, () => {
    it('declares an id', async () => {
      expect((await make()).id).toBeTruthy()
    })

    it('says whether it can run, rather than throwing', async () => {
      // Asked before anything is recorded, so a missing ffmpeg is a sentence
      // and not a failure after the user has already held the key down.
      const availability = await (await make()).available()
      expect(typeof availability.ok).toBe('boolean')
      if (!availability.ok) expect(availability.reason).toBeTruthy()
    })

    it('refuses clearly when it cannot run', async () => {
      const recorder = await make()
      if ((await recorder.available()).ok) return
      await expect(recorder.start()).rejects.toThrow(/unavailable/)
    })

    it('hands back a clip the caller owns, at the rate it asked for', async () => {
      const recorder = await make()
      if (!(await usable(recorder))) return
      const recording = await recorder.start({ sampleRate: 16_000 })
      const clip = await recording.stop()
      expect(clip.sampleRate).toBe(16_000)
      expect(clip.durationMs).toBeGreaterThanOrEqual(0)
      // The port says the caller owns the clip and deletes it, so it has to
      // really be there and really be deletable — a recorder that hands back
      // a path nobody may unlink is a fixture being kinder than reality.
      expect(existsSync(clip.path)).toBe(true)
      rmSync(clip.path, { force: true })
    })

    it('leaves nothing behind when the caller gives up', async () => {
      const recorder = await make()
      if (!(await usable(recorder))) return
      const recording = await recorder.start()
      await recording.cancel()
      // Giving up is not a failure, and it is safe to do twice — the window
      // cancels on the way out of a panel it may already have left.
      await expect(recording.cancel()).resolves.toBeUndefined()
    })

    it('either meters honestly or does not pretend to', async () => {
      const recorder = await make()
      if (!(await usable(recorder))) return
      const recording = await recorder.start()
      try {
        // Absent where a recorder cannot tell, and then nothing invents one.
        if (recording.level) {
          const level = recording.level()
          expect(level).toBeGreaterThanOrEqual(0)
          expect(level).toBeLessThanOrEqual(1)
        }
      } finally {
        await recording.cancel()
      }
    })
  })
}
