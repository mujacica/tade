import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FfmpegRecorder, levelOf } from '../src/recorder.ts'
import { fakeCapture, wavOf } from './fake-audio.ts'

// The microphone end of push-to-talk, driven through the `spawn` seam so that
// nothing here opens a device. What is faked is the ffmpeg process; everything
// being tested — the arguments, the stopping, the header-only check, the
// meter — is the real recorder.

/** A recorder wired to a fake device, with the fake in reach of the test. */
function recorder(opts: { captured?: number; platform?: NodeJS.Platform; device?: string } = {}) {
  const fake = fakeCapture({ captured: opts.captured ?? 200 })
  return {
    fake,
    recorder: new FfmpegRecorder({
      // A real path, so the recorder finds a binary without ffmpeg installed.
      binary: process.execPath,
      platform: opts.platform ?? 'darwin',
      spawn: fake.spawn,
      ...(opts.device ? { device: opts.device } : {}),
    }),
  }
}

/** Let the fake's stderr reach the recorder's handler, as a pipe does. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('whether it can record at all', () => {
  it('says so where there is no way to record, before anybody speaks', async () => {
    // The platform first: no amount of installing ffmpeg answers it, so what a
    // person is told must not depend on whether they happen to have it.
    const recorder = new FfmpegRecorder({ platform: 'win32' })
    const availability = await recorder.available()
    expect(availability.ok).toBe(false)
    if (!availability.ok) expect(availability.reason).toMatch(/win32/)
  })

  it('says how to install it, in the terms of the machine it is said on', async () => {
    const mac = await new FfmpegRecorder({
      binary: '/nonexistent/ffmpeg',
      platform: 'darwin',
    }).available()
    if (!mac.ok) expect(mac.reason).toMatch(/brew install ffmpeg/)
    const linux = await new FfmpegRecorder({
      binary: '/nonexistent/ffmpeg',
      platform: 'linux',
    }).available()
    if (!linux.ok) expect(linux.reason).toMatch(/apt install ffmpeg/)
  })

  it('refuses to start rather than pretending to record', async () => {
    const recorder = new FfmpegRecorder({ binary: '/nonexistent/ffmpeg' })
    await expect(recorder.start()).rejects.toThrow(/unavailable/)
  })
})

describe('what the recorder asks ffmpeg for', () => {
  it('opens the platform’s own kind of input', async () => {
    const mac = recorder({ platform: 'darwin' })
    await (await mac.recorder.start()).cancel()
    expect(mac.fake.starts[0]?.args).toEqual(
      expect.arrayContaining(['-f', 'avfoundation', '-i', ':0']),
    )

    const linux = recorder({ platform: 'linux' })
    await (await linux.recorder.start()).cancel()
    expect(linux.fake.starts[0]?.args).toEqual(
      expect.arrayContaining(['-f', 'pulse', '-i', 'default']),
    )
  })

  it('takes the device you chose over the platform’s default', async () => {
    const { fake, recorder: rec } = recorder({ device: ':2' })
    await (await rec.start()).cancel()
    expect(fake.starts[0]?.args).toEqual(expect.arrayContaining(['-i', ':2']))
    // And one named for this recording beats the one it was built with.
    await (await rec.start({ device: ':3' })).cancel()
    expect(fake.starts[1]?.args).toEqual(expect.arrayContaining(['-i', ':3']))
  })

  it('records mono at the rate every speech model wants', async () => {
    const { fake, recorder: rec } = recorder()
    await (await rec.start()).cancel()
    const args = fake.starts[0]?.args ?? []
    expect(args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000']))
  })

  it('caps the recording, so a stuck key cannot fill the disk', async () => {
    const { fake, recorder: rec } = recorder()
    await (await rec.start({ maxMs: 5_000 })).cancel()
    // ffmpeg counts in seconds, and a part-second is rounded up rather than off.
    expect(fake.starts[0]?.args).toEqual(expect.arrayContaining(['-t', '5']))

    await (await rec.start({ maxMs: 2_500 })).cancel()
    expect(fake.starts[1]?.args).toEqual(expect.arrayContaining(['-t', '3']))
  })

  it('starts it in its own process group, so the terminal keeps its name', async () => {
    // A child in the foreground group is what Terminal.app names the window
    // after: every push-to-talk once renamed the window `ffmpeg`.
    const { fake, recorder: rec } = recorder()
    await (await rec.start()).cancel()
    expect(fake.starts[0]?.options).toMatchObject({ detached: true })
  })
})

describe('stopping a recording', () => {
  it('asks ffmpeg to finish rather than killing it, and hands back the clip', async () => {
    const { fake, recorder: rec } = recorder({ captured: 500 })
    const recording = await rec.start()
    const clip = await recording.stop()

    // Killed, the file would be left without a valid header: `q` is the ask.
    expect(fake.capture?.typed).toBe('q')
    expect(fake.capture?.signalCode).toBeNull()
    expect(clip.sampleRate).toBe(16_000)
    expect(existsSync(clip.path)).toBe(true)
  })

  it('says what ffmpeg said when the device disappears mid-recording', async () => {
    const { fake, recorder: rec } = recorder()
    const recording = await rec.start()
    // Unplugged, taken by another program, or permission pulled — all of which
    // ffmpeg reports on stderr on its way out.
    fake.capture?.deviceLost('[avfoundation @ 0x7f8] An error occurred: device disconnected')
    await settled()

    // What the device said, not a sentence Tade made up over the top of it.
    await expect(recording.stop()).rejects.toThrow(/device disconnected/)
  })

  it('explains the silent case, which is nearly always permission', async () => {
    // Nothing captured and nothing said is what a terminal that was never
    // granted the microphone looks like: ffmpeg exits having written a header.
    const { recorder: rec } = recorder({ captured: 0 })
    const recording = await rec.start()
    await expect(recording.stop()).rejects.toThrow(/allowed to use the microphone/)
  })

  it('leaves nothing behind when it could not record', async () => {
    const { fake, recorder: rec } = recorder({ captured: 0 })
    const recording = await rec.start()
    const path = fake.capture?.path ?? ''
    await expect(recording.stop()).rejects.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

describe('giving up on a recording', () => {
  it('kills it and deletes what it had, so nothing is transcribed', async () => {
    const { fake, recorder: rec } = recorder()
    const recording = await rec.start()
    const path = fake.capture?.path ?? ''
    await recording.cancel()

    expect(fake.capture?.signalCode).toBe('SIGKILL')
    expect(existsSync(path)).toBe(false)
  })
})

describe('the meter', () => {
  it('reads the newest audio, while the recording is still going', async () => {
    const { fake, recorder: rec } = recorder()
    const recording = await rec.start()
    try {
      // Nothing written yet: silent, rather than an invented number.
      expect(recording.level?.()).toBe(0)

      // ffmpeg writes the file as it records, so the newest audio is its end.
      writeFileSync(fake.capture?.path ?? '', wavOf(300, 12_000))
      expect(recording.level?.()).toBeGreaterThan(0)
    } finally {
      await recording.cancel()
    }
  })
})

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

  it('reads a half-sample tail rather than running off the end', () => {
    // The tail is aligned to whole samples; an odd byte count is not audio.
    expect(levelOf(Buffer.alloc(1))).toBe(0)
  })
})
