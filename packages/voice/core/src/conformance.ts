import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AudioClip, Transcriber } from './port.ts'

// The shared suite every Transcriber must pass. Like the driver suite, it
// exists before the second implementation does.
//
// It deliberately asserts nothing about accuracy: what a model hears is not a
// contract, and a test that asserts on transcribed words is a test that fails
// when someone changes model. What it asserts is the contract around the
// engine — that it says whether it can run before you speak, that silence is
// not an error, and that a cancelled recording does not turn into text.

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
    `wilco-silent-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
  )
  writeFileSync(path, data)
  return { path, sampleRate, durationMs: ms }
}

export function testTranscriber(
  name: string,
  make: () => Transcriber | Promise<Transcriber>,
): void {
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
      if (!(await transcriber.available()).ok) return
      const transcript = await transcriber.transcribe(silentClip())
      expect(typeof transcript.text).toBe('string')
      expect(transcript.by).toBe(transcriber.id)
    })

    it('gives up when the caller does', async () => {
      const transcriber = await make()
      if (!(await transcriber.available()).ok) return
      const controller = new AbortController()
      controller.abort()
      await expect(
        transcriber.transcribe(silentClip(), { signal: controller.signal }),
      ).rejects.toThrow()
    })
  })
}
