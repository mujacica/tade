import { describe, expect, it } from 'vitest'
import { isReady, nextStep, type ReadinessFacts, readiness } from '../src/readiness.ts'

// The first minute on a fresh machine. What matters is that every unfinished
// step says what to do about it, and that nothing optional blocks the way.

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  configExists: true,
  projects: ['checkout'],
  cwd: '/src/checkout',
  cwdIsRepo: true,
  loggedIn: true,
  apiKeys: [],
  orchestratorModel: 'claude-opus-5',
  driver: 'pty',
  driverOk: true,
  driverChosen: true,
  talkChosen: true,
  micOk: true,
  speechOk: true,
  speechReason: null,
  judgeChosen: true,
  extensions: [{ name: 'deps', title: 'Dependencies', chosen: true }],
  ...over,
})

describe('readiness', () => {
  it('is ready when everything is in place', () => {
    const steps = readiness(facts())
    expect(isReady(steps)).toBe(true)
    expect(nextStep(steps)).toBeNull()
  })

  it('asks about the repository you are standing in', () => {
    const steps = readiness(facts({ projects: [], cwd: '/src/checkout', cwdIsRepo: true }))
    // Almost always the one you meant, so it is a confirmation not a survey.
    expect(nextStep(steps)).toMatchObject({ id: 'project', done: false })
    expect(nextStep(steps)?.detail).toContain('/src/checkout')
  })

  it('says so plainly when there is nothing to add', () => {
    const steps = readiness(facts({ projects: [], cwdIsRepo: false, cwd: '/tmp' }))
    expect(nextStep(steps)?.detail).toContain('not a git repository')
  })

  it('separates having no credentials from having no model', () => {
    const noCredentials = readiness(facts({ loggedIn: false, apiKeys: [] }))
    expect(nextStep(noCredentials)?.detail).toContain('no provider is logged in')

    // Different problem, different sentence: a key is set but nothing says
    // which model to use with it.
    const noModel = readiness(
      facts({ loggedIn: false, apiKeys: ['ANTHROPIC_API_KEY'], orchestratorModel: null }),
    )
    expect(nextStep(noModel)?.detail).toContain('ANTHROPIC_API_KEY')
    expect(nextStep(noModel)?.detail).toContain('no model is named')
  })

  it('counts a logged-in provider as credentials, with no key set', () => {
    expect(isReady(readiness(facts({ loggedIn: true, apiKeys: [] })))).toBe(true)
  })

  it('asks where agents should live until somebody has said', () => {
    // Whether a night's work stops when you shut your laptop is not a thing to
    // decide by default and never mention.
    const steps = readiness(facts({ driverChosen: false }))
    const workspace = steps.find((s) => s.id === 'workspace')
    expect(workspace).toMatchObject({ done: false, required: false })
    expect(workspace?.detail).toContain('agents stop when Tade does')
    // Not required: a working driver is enough to run, so this never blocks.
    expect(isReady(steps)).toBe(true)
  })

  it('notices a driver this machine cannot provide', () => {
    const steps = readiness(facts({ driver: 'tmux', driverOk: false }))
    expect(nextStep(steps)?.id).toBe('workspace')
    // Naming the driver is what makes it fixable.
    expect(nextStep(steps)?.detail).toContain('tmux')
  })

  it('never lets speech block anything', () => {
    const steps = readiness(
      facts({ micOk: false, speechOk: false, speechReason: 'ffmpeg is not installed' }),
    )
    // Typing works perfectly well; this is not a reason to stop.
    expect(isReady(steps)).toBe(true)
    expect(steps.find((s) => s.id === 'voice')).toMatchObject({
      done: false,
      required: false,
      detail: 'ffmpeg is not installed',
    })
  })

  it('asks in a sensible order', () => {
    const steps = readiness(
      facts({ projects: [], loggedIn: false, apiKeys: [], driverOk: false, speechOk: false }),
    )
    // The talk key late, so the window opens on the key you just picked; the
    // judge after it, because it is the only step that costs money and the
    // only one that sends anything anywhere; the extensions last, so whatever
    // the judge step already answered is not asked a second time.
    expect(steps.map((s) => s.id)).toEqual([
      'project',
      'model',
      'workspace',
      'voice',
      'talk',
      'judge',
      'extensions',
    ])
    // A project first: choosing a model for nothing is a strange way to start.
    expect(nextStep(steps)?.id).toBe('project')
  })

  it('never lets a judge block anything, and takes “not now” for an answer', () => {
    const unasked = readiness(facts({ judgeKey: false, judgeChosen: false }))
    const step = unasked.find((one) => one.id === 'judge')
    expect(step).toMatchObject({ done: false, required: false })
    expect(step?.detail).toContain('nothing runs without it')
    // `tade setup --check` still exits 0 with it undone.
    expect(isReady(unasked)).toBe(true)

    // A key found in the environment is an answer, and so is “not now”.
    for (const answered of [{ judgeKey: true }, { judgeChosen: true }]) {
      const steps = readiness(facts({ judgeKey: false, judgeChosen: false, ...answered }))
      expect(steps.find((one) => one.id === 'judge')).toMatchObject({ done: true, detail: '' })
      expect(nextStep(steps)).toBeNull()
    }
  })

  it('asks which extensions to use, and only about the ones nobody has decided', () => {
    // Nothing is on because it is there, so the question is real; one already
    // answered — here, or in the window — is never asked again.
    const some = readiness(
      facts({
        extensions: [
          { name: 'deps', title: 'Dependencies', chosen: true },
          { name: 'sentry', title: 'Sentry', chosen: false },
        ],
      }),
    )
    const step = some.find((one) => one.id === 'extensions')
    expect(step).toMatchObject({ done: false, required: false })
    expect(step?.detail).toContain('Sentry')
    // Never a reason to stop: without any of them Tade is exactly itself.
    expect(isReady(some)).toBe(true)
    expect(
      readiness(facts({ extensions: [] })).find((one) => one.id === 'extensions'),
    ).toMatchObject({ done: true, detail: '' })
  })

  it('every unfinished step says what to do about it', () => {
    const steps = readiness(
      facts({
        projects: [],
        loggedIn: false,
        apiKeys: [],
        orchestratorModel: null,
        driverOk: false,
        micOk: false,
        speechOk: false,
        speechReason: 'whisper.cpp is not installed',
        talkChosen: false,
        judgeChosen: false,
        extensions: [{ name: 'deps', title: 'Dependencies', chosen: false }],
      }),
    )
    for (const step of steps) {
      expect(step.done).toBe(false)
      expect(step.detail.length).toBeGreaterThan(0)
    }
  })
})
