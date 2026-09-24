import { describe, expect, it } from 'vitest'
import { isReady, nextStep, type ReadinessFacts, readiness, worksStep } from '../src/readiness.ts'

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
    // What Tade is built on and what it shells out to first, because
    // everything below them is answered by running something in a lane; the
    // talk key late, so the window opens on the key you just picked; the judge
    // after it, because it is the only step that costs money and the only one
    // that sends anything anywhere; the extensions after that, so whatever the
    // judge step already answered is not asked a second time; and the keys
    // last of all, because which are wanted is decided by which are on.
    expect(steps.map((s) => s.id)).toEqual([
      'native',
      'programs',
      'project',
      'model',
      'workspace',
      'voice',
      'talk',
      'judge',
      'extensions',
      'keys',
    ])
    // A project first of what is left: choosing a model for nothing is a
    // strange way to start, and nothing was found wrong with this machine.
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

  it('reads a machine nobody looked at as nothing to do', () => {
    // The window asks for readiness on every open and must not pay for a PATH
    // walk to get it, so absent facts are absent rather than alarming.
    const steps = readiness(facts())
    for (const id of ['native', 'programs', 'keys'] as const) {
      expect(steps.find((one) => one.id === id)).toMatchObject({ done: true, detail: '' })
    }
    expect(isReady(steps)).toBe(true)
  })

  it('stops for a native module that stops Tade, and only says the other', () => {
    const helper = {
      module: 'node-pty',
      clause: 'node-pty cannot spawn, so no lane can open',
      fix: 'chmod +x …',
      blocking: true,
    }
    const index = {
      module: 'better-sqlite3',
      clause: 'better-sqlite3 did not load, so the journal has no index',
      fix: 'npm install …',
      blocking: false,
    }
    const stopped = readiness(facts({ native: [helper] }))
    expect(stopped.find((one) => one.id === 'native')).toMatchObject({
      done: false,
      required: true,
    })
    expect(isReady(stopped)).toBe(false)

    // The journal works without its index, so a broken one is said and is
    // never a reason to stop.
    const said = readiness(facts({ native: [index] }))
    expect(said.find((one) => one.id === 'native')).toMatchObject({ done: false, required: false })
    expect(said.find((one) => one.id === 'native')?.detail).toContain('no index')
    expect(isReady(said)).toBe(true)

    // Both at once is still a stop: what actually stops Tade decides.
    expect(isReady(readiness(facts({ native: [index, helper] })))).toBe(false)
  })

  it('is only held up by a program something it uses actually needs', () => {
    const tmux = {
      command: 'tmux',
      title: 'tmux',
      why: 'holding every lane',
      optional: true,
      install: { command: 'brew install tmux' },
    }
    const git = {
      command: 'git',
      title: 'git',
      why: 'every commit an agent makes',
      optional: false,
      install: { command: 'brew install git' },
    }
    // tmux on a machine running the pty driver is a row on a page, not a
    // question, and never a reason to stop.
    const spare = readiness(facts({ missing: [tmux] }))
    expect(spare.find((one) => one.id === 'programs')).toMatchObject({ done: true, detail: '' })
    expect(isReady(spare)).toBe(true)

    const needed = readiness(facts({ missing: [tmux, git] }))
    const step = needed.find((one) => one.id === 'programs')
    expect(step).toMatchObject({ done: false, required: true })
    // What it is for, so the offer to install it is a decision somebody can make.
    expect(step?.detail).toContain('every commit an agent makes')
    expect(step?.detail).not.toContain('tmux')
  })

  it('says the driver’s own words about why it cannot run here', () => {
    // “not installed” is the wrong sentence for a driver that is installed and
    // cannot spawn, which is the one thing a machine gets wrong here.
    const steps = readiness(
      facts({
        driverOk: false,
        driverReason: 'node-pty’s spawn-helper is not executable',
      }),
    )
    expect(steps.find((one) => one.id === 'workspace')?.detail).toBe(
      'node-pty’s spawn-helper is not executable',
    )
    // And with nothing said, it still says something.
    expect(
      readiness(facts({ driverOk: false })).find((one) => one.id === 'workspace')?.detail,
    ).toContain('not installed')
  })

  it('asks for a key only where something that is on wants one', () => {
    const steps = readiness(
      facts({ keysWanted: [{ extension: 'jev', title: 'Jev', problem: 'it needs a key' }] }),
    )
    const step = steps.find((one) => one.id === 'keys')
    expect(step).toMatchObject({ done: false, required: false })
    expect(step?.detail).toContain('Jev: it needs a key')
    // A key is never a reason to stop: everything works without every one.
    expect(isReady(steps)).toBe(true)
  })

  it('is not ready until a lane has actually opened, and says so before it is tried', () => {
    // The act, not a fact: it is deliberately not one of the steps the window
    // reads on every open, which is why it is its own function.
    expect(readiness(facts()).some((step) => step.id === 'works')).toBe(false)

    expect(worksStep(null)).toMatchObject({ done: false, detail: 'not tried yet', required: true })
    expect(worksStep({ ok: true, driver: 'pty', says: 'opened a lane under pty' })).toMatchObject({
      done: true,
      detail: '',
    })
    const failed = worksStep({ ok: false, driver: 'tmux', says: 'tmux is not installed' })
    expect(failed).toMatchObject({ done: false, required: true })
    expect(failed.detail).toBe('tmux is not installed')
    expect(isReady([...readiness(facts()), failed])).toBe(false)
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
        native: [
          { module: 'node-pty', clause: 'it cannot spawn', fix: 'chmod +x …', blocking: true },
        ],
        missing: [
          {
            command: 'git',
            title: 'git',
            why: 'every reading of a project',
            optional: false,
            install: { command: 'brew install git' },
          },
        ],
        keysWanted: [{ extension: 'jev', title: 'Jev', problem: 'it needs a key' }],
      }),
    )
    for (const step of steps) {
      expect(step.done).toBe(false)
      expect(step.detail.length).toBeGreaterThan(0)
    }
  })
})
