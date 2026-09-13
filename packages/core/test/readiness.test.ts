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
  micOk: true,
  speechOk: true,
  speechReason: null,
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
    expect(steps.map((s) => s.id)).toEqual(['project', 'model', 'workspace', 'voice'])
    // A project first: choosing a model for nothing is a strange way to start.
    expect(nextStep(steps)?.id).toBe('project')
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
      }),
    )
    for (const step of steps) {
      expect(step.done).toBe(false)
      expect(step.detail.length).toBeGreaterThan(0)
    }
  })
})
