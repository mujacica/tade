import { describe, expect, it } from 'vitest'
import { progressLine, WHISPER_MODELS } from '../src/commands/voice.ts'

// Speech setup: what is on offer, and what a long download looks like while
// you are waiting for it.

describe('the models on offer', () => {
  it('offers both English-only and any-language models', () => {
    // The `.en` ones are better at English for their size; everything else
    // understands about a hundred languages. That is the actual choice.
    expect(WHISPER_MODELS.some((model) => model.english)).toBe(true)
    expect(WHISPER_MODELS.some((model) => !model.english)).toBe(true)
  })

  it('says what each one costs to download, before you commit to it', () => {
    for (const model of WHISPER_MODELS) {
      expect(model.size).toMatch(/\d+ (MB|GB)/)
      expect(model.note).not.toBe('')
    }
  })
})

describe('the download progress line', () => {
  it('shows how far along, how fast, and how much longer', () => {
    const line = progressLine(50_000_000, 142_000_000, 5_000_000)
    expect(line).toContain('35%')
    expect(line).toContain('50 MB of 142 MB')
    expect(line).toContain('· 5 MB/s')
    // The number people actually want: when can I stop watching this.
    expect(line).toContain('19s left')
  })

  it('fills the bar as it goes', () => {
    expect(progressLine(0, 100, 0)).toContain('░')
    const half = progressLine(50, 100, 0)
    expect(half).toContain('█')
    expect(half).toContain('░')
    expect(progressLine(100, 100, 0)).not.toContain('░')
  })

  it('says something useful before the speed is known', () => {
    // The first chunk arrives before there is any rate to report, and a line
    // that says "0 MB/s" reads as stalled.
    const line = progressLine(1_000_000, 142_000_000, 0)
    expect(line).not.toContain('/s')
    expect(line).toContain('1 MB of 142 MB')
  })

  it('stops counting down once it is finished', () => {
    const line = progressLine(78_000_000, 78_000_000, 4_000_000)
    expect(line).toContain('100%')
    // "a moment left" under a full bar reads as something still happening.
    expect(line).not.toContain('left')
  })

  it('copes with a server that does not say how big the file is', () => {
    const line = progressLine(5_000_000, 0, 1_000_000)
    expect(line).toContain('5 MB')
    expect(line).not.toContain('of 0')
  })

  it('reads slow as slow rather than as stopped', () => {
    expect(progressLine(500_000, 142_000_000, 90_000)).toContain('90 KB/s')
  })
})
