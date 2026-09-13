import { describe, expect, it } from 'vitest'
import { levelOf } from '../src/recorder.ts'

// How loud the microphone is hearing you, from the PCM ffmpeg is writing.

describe('levelOf', () => {
  const pcm = (value: number, samples = 1600) => {
    const buffer = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) buffer.writeInt16LE(i % 2 === 0 ? value : -value, i * 2)
    return buffer
  }

  it('is silent for silence, and for nothing at all', () => {
    expect(levelOf(pcm(0))).toBe(0)
    expect(levelOf(Buffer.alloc(0))).toBe(0)
  })

  it('rises with loudness and never passes the top', () => {
    const quiet = levelOf(pcm(500))
    const loud = levelOf(pcm(12_000))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(levelOf(pcm(32_767))).toBeLessThanOrEqual(1)
  })
})
