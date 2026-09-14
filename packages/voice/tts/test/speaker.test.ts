import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { type Command, Speaker, TONES, toneWav } from '../src/speaker.ts'

function recorder() {
  const calls: Command[] = []
  return { calls, run: async (command: Command) => void calls.push(command) }
}

describe('toneWav', () => {
  it('writes a real mono 16-bit WAV', () => {
    const wav = toneWav({ steps: [880], msPerStep: 100 }, 22_050)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.subarray(8, 12).toString()).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(22_050) // sample rate
    expect(wav.readUInt16LE(34)).toBe(16) // bits

    // 100ms at 22050Hz, 2 bytes a sample, plus a 44 byte header.
    const samples = Math.floor(0.1 * 22_050)
    expect(wav.readUInt32LE(40)).toBe(samples * 2)
    expect(wav.byteLength).toBe(44 + samples * 2)
  })

  it('a rest is silence, not a click', () => {
    const wav = toneWav({ steps: [0], msPerStep: 50 })
    const data = wav.subarray(44)
    expect(data.every((byte) => byte === 0)).toBe(true)
  })

  it('fades the edges, so steps do not click', () => {
    const wav = toneWav({ steps: [880], msPerStep: 100 })
    expect(Math.abs(wav.readInt16LE(44))).toBeLessThan(50)
    expect(Math.abs(wav.readInt16LE(wav.byteLength - 2))).toBeLessThan(600)
  })

  it('the three earcons are actually different sounds', () => {
    const [blocked, review, failed] = (['blocked', 'review', 'failed'] as const).map((tone) =>
      toneWav(TONES[tone]).subarray(44).toString('base64'),
    )
    expect(blocked).not.toBe(review)
    expect(blocked).not.toBe(failed)
    expect(review).not.toBe(failed)
  })

  it('blocked falls and review rises, which is what makes them learnable', () => {
    expect(TONES.blocked.steps[0]).toBeGreaterThan(TONES.blocked.steps[1]!)
    expect(TONES.review.steps[0]).toBeLessThan(TONES.review.steps[1]!)
    expect(TONES.failed.steps).toContain(0) // a gap: two flat beeps
  })
})

describe('Speaker', () => {
  it('uses the built-in voice and player on macOS', async () => {
    const { calls, run } = recorder()
    const speaker = await Speaker.create({ soundDir: tmp('wilco-sound-'), platform: 'darwin', run })
    expect(speaker.capabilities).toEqual({ speech: true, sound: true })

    await speaker.speak('Checkout is blocked')
    expect(calls[0]).toMatchObject({ command: 'say' })
    expect(calls[0]?.args).toContain('Checkout is blocked')

    await speaker.earcon('blocked')
    expect(calls[1]?.command).toBe('afplay')
    expect(calls[1]?.args[0]).toMatch(/blocked\.wav$/)
  })

  it('uses speech-dispatcher and paplay on Linux', async () => {
    const { calls, run } = recorder()
    const speaker = await Speaker.create({ soundDir: tmp('wilco-sound-'), platform: 'linux', run })
    await speaker.speak('hello')
    await speaker.earcon('review')
    expect(calls.map((c) => c.command)).toEqual(['spd-say', 'paplay'])
  })

  it('stays quiet, rather than failing, where there is no audio', async () => {
    const { calls, run } = recorder()
    const speaker = await Speaker.create({ soundDir: tmp('wilco-sound-'), platform: 'win32', run })
    expect(speaker.capabilities).toEqual({ speech: false, sound: false })
    await speaker.speak('hello')
    await speaker.earcon('failed')
    expect(calls).toEqual([])
  })

  it('gives speech commands no timeout so long text is not cut off', async () => {
    const { calls, run } = recorder()
    const speaker = await Speaker.create({ soundDir: tmp('wilco-sound-'), platform: 'darwin', run })
    await speaker.speak('A very long sentence that could take more than twenty seconds.')
    expect(calls[0]?.timeout).toBe(0)
  })

  it('writes the earcons once, ready to play', async () => {
    const soundDir = tmp('wilco-sound-')
    const speaker = await Speaker.create({ soundDir, platform: 'darwin', run: recorder().run })
    for (const tone of ['blocked', 'review', 'failed'] as const) {
      expect(existsSync(speaker.toneFile(tone))).toBe(true)
      expect(readFileSync(speaker.toneFile(tone)).subarray(0, 4).toString()).toBe('RIFF')
    }
  })

  it('a missing audio tool never takes the rest of Wilco down', async () => {
    const speaker = await Speaker.create({
      soundDir: tmp('wilco-sound-'),
      platform: 'darwin',
      run: async () => {
        throw new Error('afplay: command not found')
      },
    })
    await expect(speaker.speak('still fine')).resolves.toBeUndefined()
    await expect(speaker.earcon('blocked')).resolves.toBeUndefined()
  })

  it('says nothing when there is nothing to say', async () => {
    const { calls, run } = recorder()
    const speaker = await Speaker.create({ soundDir: tmp('wilco-sound-'), platform: 'darwin', run })
    await speaker.speak('   ')
    expect(calls).toEqual([])
  })
})
