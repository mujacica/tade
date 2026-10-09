import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  INTAKE_SETUP,
  type IntakeCandidate,
  type IntakeGrantRead,
  intakeContext,
  intakeDecision,
  intakeKey,
  intakeMapped,
  intakePrompt,
  intakeSummary,
  intakeUnfinished,
  mustBeTold,
  newerRevision,
  watchesToOffer,
} from '@tade/core'
import { type ExtensionContext, ExtensionHost, intakeProblem } from '@tade/extensions-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { githubReplay, type ReplayOptions } from '../../../../test/fixtures/forge/github.ts'
import { intakeExtension } from '../src/extension.ts'
import { githubIssues, MOST_READ, refOf } from '../src/github.ts'

// The GitHub door, against a real git checkout and a GitHub that answers from
// files.
//
// **Two halves, each real.** The repository is read with real git out of a real
// checkout, because that is the mapping and a mocked remote would prove
// nothing about it; GitHub is a fake `fetch` over its own documented shapes,
// because the alternative is a test that spends somebody's rate limit. Nothing
// here reaches the network, and the global `fetch` is taken away for the whole
// file so that anything which tried would fail here rather than quietly
// succeed on a laptop and fail in CI.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the GitHub intake tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const run = promisify(execFile)

/** A real checkout whose `origin` is a GitHub repository. Real git, every time. */
async function checkout(remote = 'git@github.com:acme/api.git'): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'tade-gh-intake-'))
  await run('git', ['-C', root, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', root, 'remote', 'add', 'origin', remote])
  return root
}

/**
 * The host, with real git and a scripted GitHub.
 *
 * One `exec` for both, dispatched by program: `git` is the real thing against
 * the real checkout, and `gh` is the replay's — which is where the credential
 * comes from, so nothing here needs a token and nothing here has one to leak.
 */
async function host(root: string, options: ReplayOptions = {}) {
  const replay = githubReplay(options)
  const exec: ExtensionContext['exec'] = async (command, args) => {
    if (command === 'git') {
      try {
        const { stdout } = await run(command, [...args])
        return { code: 0, stdout, stderr: '' }
      } catch (err) {
        const said = err as { code?: number; stdout?: string; stderr?: string }
        return { code: said.code ?? 1, stdout: said.stdout ?? '', stderr: said.stderr ?? '' }
      }
    }
    return replay.exec(command, args)
  }
  const loaded = await ExtensionHost.load({
    builtin: [intakeExtension],
    config: { extensions: {}, projects: { app: { root } } },
    home: mkdtempSync(join(tmpdir(), 'tade-gh-home-')),
    env: {},
    fetch: replay.fetch,
    exec,
  })
  return { loaded, replay }
}

const TURNED_ON = '2026-09-19T00:00:00.000Z'

const looking = (over: { since?: string | null; label?: string } = {}) => ({
  project: 'app',
  input: { label: over.label ?? 'tade' },
  since: over.since ?? null,
  turnedOn: TURNED_ON,
})

/** A grant written as an owner would write one, for the rule below the watch. */
const grant = (over: Partial<IntakeGrantRead> = {}): IntakeGrantRead => ({
  path: 'surfaces.intake.sources.github',
  on: true,
  accept: true,
  reply: false,
  projects: ['app'],
  from: ['kim'],
  mode: 'propose',
  template: '',
  document: '',
  ...over,
})

describe('what selects an issue', () => {
  let root: string

  beforeEach(async () => {
    root = await checkout()
  })

  it('reads the repository out of the checkout, and takes no repository from anybody', async () => {
    const { loaded, replay } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    // The one request the list costs, against the repository the checkout's own
    // remote names. There is no input that could have said a different one.
    expect(replay.calls.some((one) => one.includes('/repos/acme/api/issues?'))).toBe(true)
    expect(looked.found.length).toBeGreaterThan(0)
    const offer = loaded.watches().find((one) => one.id === 'intake.github')
    expect(Object.keys((offer?.input?.properties ?? {}) as object)).toEqual(['label'])
  })

  it('leaves out the pull request, the closed one and the one with no label', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const ids = looked.found.map((one) => (one.intake as IntakeCandidate).externalId)
    // 504 is a pull request the issues endpoint answers about; 505 is closed;
    // 502 carries no label. Each of those is the selector not matching, which
    // is nothing written down anywhere — the journal is not for the world.
    expect(ids).not.toContain('acme/api#504')
    expect(ids).not.toContain('acme/api#505')
    expect(ids).not.toContain('acme/api#502')
    expect(ids).toContain('acme/api#501')
  })

  it('makes the person who applied the label the requester, not the one who filed it', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const found = looked.found.find(
      (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#506',
    )
    const candidate = found?.intake as IntakeCandidate
    // 506 was filed by kim and labelled by stranger. Applying the label is the
    // act that asked, so stranger is the requester — and with kim's own list
    // naming only kim, this is refused rather than started.
    expect(candidate.requester.id).toBe('stranger')
    expect(candidate.requester.label).toContain('@kim filed it')
    const decision = intakeDecision(candidate, grant(), { project: 'app' })
    expect(decision.outcome).toBe('refused')
    expect(decision.outcome === 'refused' && decision.why).toBe('not_allowed')
    // And the other way round: the author being on the list buys nothing,
    // because the list is not read against the author at all.
    const asAuthor = intakeDecision(candidate, grant({ from: ['kim'] }), { project: 'app' })
    expect(asAuthor.outcome).toBe('refused')
  })

  it('says nothing about a label where the author applied it, having nothing to add', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const candidate = looked.found.find(
      (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#501',
    )?.intake as IntakeCandidate
    expect(candidate.requester.id).toBe('kim')
    expect(candidate.requester.label).toBe('')
    expect(intakeDecision(candidate, grant(), { project: 'app' }).outcome).toBe('accepted')
  })

  it('hands an app’s labelling over to be refused as an app’s', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const candidate = looked.found.find(
      (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#503',
    )?.intake as IntakeCandidate
    expect(candidate.requester.bot).toBe(true)
    // Written down rather than quietly dropped: a refusal nobody made is what
    // makes an attack invisible, and `is_bot` is the loop filter by actor.
    const decision = intakeDecision(candidate, grant({ from: ['dependabot[bot]'] }), {
      project: 'app',
    })
    expect(decision.outcome === 'refused' && decision.why).toBe('is_bot')
  })

  it('selects nothing from a label nobody can be named for applying', async () => {
    const { loaded } = await host(root, {
      // The label is on it and the events say nothing about who put it there.
      issueEvents: { '501': [], '503': [], '506': [] },
    })
    const looked = await loaded.look('intake.github', looking())
    expect(looked.found).toEqual([])
    // Said, rather than passed over: the one reason nothing was found is
    // something somebody can act on.
    expect(looked.said).toContain('cannot name who applied it')
    expect(looked.said).toContain('#501')
  })

  it('reads the body as written and lists no attachment it did not download', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const candidate = looked.found.find(
      (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#501',
    )?.intake as IntakeCandidate
    expect(candidate.verbatim).toContain('Refund retries drop the idempotency key')
    expect(candidate.verbatim).toContain('kill the worker mid-flight')
    // A GitHub issue has no attachment list — what looks like one is a link in
    // the body, where it reads as theirs. Nothing is lifted out and nothing is
    // fetched, so there is no stranger's filename in a line Tade wrote.
    expect(candidate.attachments).toEqual([])
    expect(candidate.material.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(candidate.url).toBe('https://github.com/acme/api/issues/501')
  })

  it('never lets the words reach the field drawn as the person’s own', async () => {
    const { loaded } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const candidate = looked.found.find(
      (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#501',
    )?.intake as IntakeCandidate
    const mapped = intakeMapped(candidate.from, grant())
    const envelope = {
      ...candidate,
      project: 'app',
      mapping: { from: candidate.from, by: mapped.by },
      grant: 'surfaces.intake.sources.github',
    }
    const said = intakeSummary(envelope)
    const agent = await looked.agent(
      looked.found.find(
        (one) => (one.intake as IntakeCandidate).externalId === 'acme/api#501',
      ) as Parameters<typeof looked.agent>[0],
    )
    for (const sentence of [said, agent.prompt, agent.title]) {
      expect(sentence).not.toContain('kill the worker mid-flight')
    }
    expect(agent.prompt).toBe(intakePrompt(candidate))
    // The body goes in the context file, under the one wording of what
    // material means, and the provenance is legible there too.
    const context = intakeContext(envelope)
    expect(context).toContain('kill the worker mid-flight')
    expect(context).toContain('material')
  })

  it('reads at most a bounded number in full, and says a backlog is deeper', async () => {
    const many = Array.from({ length: MOST_READ + 3 }, (_, at) => ({
      number: 700 + at,
      title: `one of many ${at}`,
      body: '',
      html_url: `https://github.com/acme/api/issues/${700 + at}`,
      state: 'open',
      user: { login: 'kim', type: 'User' },
      labels: [{ name: 'tade' }],
      assignees: [],
      created_at: '2026-09-19T01:00:00Z',
      updated_at: `2026-09-19T0${1 + (at % 8)}:00:00Z`,
    }))
    const { loaded, replay } = await host(root, { issues: many, issueEvents: {} })
    const looked = await loaded.look('intake.github', looking())
    expect(looked.found).toEqual([])
    expect(looked.said).toContain('3 more carried it than one look reads')
    // One list and one detail each, never one per issue in the repository.
    const details = replay.calls.filter((one) => /\/issues\/\d+$/.test(one))
    expect(details.length).toBe(MOST_READ)
  })
})

describe('what a poll costs', () => {
  let root: string

  beforeEach(async () => {
    root = await checkout()
  })

  it('carries a validator across looks, and reads an unchanged list as unchanged', async () => {
    const { loaded, replay } = await host(root)
    const first = await loaded.look('intake.github', looking())
    expect(first.found.length).toBeGreaterThan(0)
    expect(first.since).toMatch(/^etag:/)
    const details = replay.calls.filter((one) => /\/issues\/\d+$/.test(one)).length
    const again = await loaded.look('intake.github', looking({ since: first.since }))
    // Nothing moved, so nothing was read — and not one issue was opened in
    // full, which is the whole of why a ten-minute poll costs nothing.
    expect(again.found).toEqual([])
    expect(again.said).toContain('nothing has moved in acme/api')
    expect(replay.calls.filter((one) => /\/issues\/\d+$/.test(one)).length).toBe(details)
    expect(again.since).toBe(first.since)
  })

  it('asks only for what moved since it was turned on', async () => {
    const { loaded, replay } = await host(root)
    await loaded.look('intake.github', looking())
    const asked = decodeURIComponent(replay.calls.find((one) => one.includes('/issues?')) ?? '')
    // What was already labelled when the watch was turned on is not news, and
    // the moment it was turned on is the one fixed point — which also keeps the
    // question identical between looks, which is what makes the 304 match.
    expect(asked).toContain(`since=${TURNED_ON}`)
    expect(asked).toContain('labels=tade')
  })

  it('keeps looking against a GitHub that hands back no validator', async () => {
    const { loaded } = await host(root, { etags: false })
    const first = await loaded.look('intake.github', looking())
    expect(first.found.length).toBeGreaterThan(0)
    const again = await loaded.look('intake.github', looking({ since: first.since }))
    expect(again.found.length).toBe(first.found.length)
  })
})

describe('what a look cannot do', () => {
  let root: string

  beforeEach(async () => {
    root = await checkout()
  })

  it('refuses to look at all without the label, and offers no default for it', async () => {
    const { loaded } = await host(root)
    // The whole of the opt-in: a watch nothing can turn on by pressing enter.
    expect(loaded.watchProblem('intake.github', {})).toContain('label is needed')
    expect(loaded.watchProblem('intake.github', { label: 'tade' })).toBeNull()
    await expect(
      loaded.look('intake.github', { ...looking(), input: { label: '  ' } }),
    ).rejects.toThrow(/needs the label/)
  })

  it('is not offered in the first minute, because there is nothing to tell it', async () => {
    const { loaded } = await host(root)
    const offer = loaded.watches().find((one) => one.id === 'intake.github')
    expect(offer?.needs).toEqual(['label'])
    const choice = watchesToOffer(loaded.watches()).find((one) => one.id === 'intake.github')
    expect(choice?.state).toBe('cannot')
    expect(choice?.ticked).toBe(false)
    expect(choice?.costs).toBe(mustBeTold(['label']))
    // And the local door, which needs nothing, is still offered.
    expect(watchesToOffer(loaded.watches()).find((one) => one.id === 'intake.cli')?.state).toBe(
      'offered',
    )
  })

  it('says a project with no GitHub repository has none, rather than reading somebody else’s', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'tade-gh-bare-'))
    await run('git', ['-C', bare, 'init', '-q', '-b', 'main'])
    const { loaded } = await host(bare)
    await expect(loaded.look('intake.github', looking())).rejects.toThrow(
      /no GitHub repository to read issues from/,
    )
  })

  it('reports nothing coming back as the host being unreachable, and an answer as an answer', async () => {
    const { loaded: offline } = await host(root, { unreachable: true })
    await expect(offline.look('intake.github', looking())).rejects.toMatchObject({
      name: 'Unreachable',
      host: 'github.com',
    })
    // A rate limit and a 500 are GitHub answering: one endpoint being down is
    // never this machine being offline, and only the second may pause a watch.
    for (const options of [{ limited: true }, { serverError: true }, { signedOut: true }]) {
      const { loaded } = await host(root, options)
      await expect(loaded.look('intake.github', looking())).rejects.not.toMatchObject({
        name: 'Unreachable',
      })
    }
  })

  it('puts no credential in anything it hands back or throws', async () => {
    const { loaded, replay } = await host(root)
    const looked = await loaded.look('intake.github', looking())
    const everything = JSON.stringify({ found: looked.found, said: looked.said ?? '' })
    // The replay's tokens look like `gho_<account>token`, and the forge reads
    // one out of `gh` on every request: none of it may come back out.
    expect(everything).not.toMatch(/gho_/)
    expect(everything).not.toMatch(/Bearer/)
    expect(replay.calls.some((one) => one.startsWith('gh auth token'))).toBe(true)
    const { loaded: out } = await host(root, { signedOut: true })
    const err = await out.look('intake.github', looking()).catch((one) => one)
    expect(String(err instanceof Error ? err.message : err)).not.toMatch(/gho_/)
  })
})

describe('whether an issue still stands, at the moment work would start', () => {
  let root: string

  beforeEach(async () => {
    root = await checkout()
  })

  const key = (revision = '2026-09-19T08:00:00Z') =>
    intakeKey({ source: 'github', externalId: 'acme/api#501', revision })

  it('pulls a key apart without reading the hour as a revision', () => {
    // A GitHub revision is an ISO timestamp and has colons of its own, so
    // `split(':')` hands back `2026-09-19T08` as the whole of it.
    expect(refOf(key())).toEqual({
      externalId: 'acme/api#501',
      revision: '2026-09-19T08:00:00Z',
    })
    expect(refOf('nonsense')).toBeNull()
  })

  it('says it still stands when nothing about it has moved', async () => {
    const { loaded } = await host(root)
    expect(await loaded.recheck('intake.github', { ...looking(), key: key() })).toEqual({
      still: true,
    })
  })

  it('holds a closed issue, and says so', async () => {
    const { loaded } = await host(root)
    const answer = await loaded.recheck('intake.github', {
      ...looking(),
      key: intakeKey({
        source: 'github',
        externalId: 'acme/api#505',
        revision: '2026-09-19T12:00:00Z',
      }),
    })
    expect(answer).toEqual({ still: false, because: 'acme/api#505 was closed' })
  })

  it('holds one the label has been taken off', async () => {
    const { loaded } = await host(root)
    const answer = await loaded.recheck('intake.github', {
      ...looking({ label: 'something-else' }),
      key: key(),
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain(
      'something-else label has been taken off',
    )
  })

  it('holds one nobody can be named for labelling any more', async () => {
    const { loaded } = await host(root, { issueEvents: { '501': [] } })
    const answer = await loaded.recheck('intake.github', { ...looking(), key: key() })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('nobody can be named')
  })

  it('holds one that has moved — edited, relabelled, commented on or reassigned', async () => {
    const { loaded } = await host(root)
    // Every one of those moves GitHub's `updated_at`, which is why they all
    // arrive here as the revision not being the one the work was made for.
    const answer = await loaded.recheck('intake.github', {
      ...looking(),
      key: key('2026-09-19T07:00:00Z'),
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain(
      'has moved since the work was made for',
    )
  })

  it('holds a revision nobody can order', async () => {
    const { loaded } = await host(root)
    const answer = await loaded.recheck('intake.github', { ...looking(), key: key('whenever') })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('cannot be ordered')
  })

  it('holds one that is gone, or that this sign-in can no longer see', async () => {
    const { loaded } = await host(root)
    const answer = await loaded.recheck('intake.github', {
      ...looking(),
      key: intakeKey({
        source: 'github',
        externalId: 'acme/api#4040',
        revision: '2026-09-19T08:00:00Z',
      }),
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('can no longer see it')
  })

  it('holds a key naming a repository this project does not read', async () => {
    const { loaded } = await host(root)
    const answer = await loaded.recheck('intake.github', {
      ...looking(),
      key: intakeKey({
        source: 'github',
        externalId: 'somebody/else#1',
        revision: '2026-09-19T08:00:00Z',
      }),
    })
    expect(answer.still).toBe(false)
    expect(answer.still === false && answer.because).toContain('is not in acme/api')
  })

  it('throws rather than answering when GitHub could not be asked', async () => {
    // A shrug is not a yes and it is not a no either: the start door turns a
    // throw into a hold that says the source could not be asked. The one
    // direction this must get right.
    for (const options of [{ limited: true }, { serverError: true }, { unreachable: true }]) {
      const { loaded } = await host(root, options)
      await expect(loaded.recheck('intake.github', { ...looking(), key: key() })).rejects.toThrow()
    }
  })
})

describe('what it may never do', () => {
  it('has no way of saying anything back to GitHub at all', async () => {
    const root = await checkout()
    const { loaded } = await host(root)
    // Enforced by absence rather than by a flag, which is the stronger of the
    // two: with no way to write a word into GitHub, nothing Tade reads there
    // can be something Tade wrote.
    expect(githubIssues.reply).toBeUndefined()
    expect(loaded.watches().find((one) => one.id === 'intake.github')?.replies).toBe(false)
    await expect(
      loaded.reply('intake.github', { ...looking(), key: 'github:acme/api#501:x', say: 'hi' }),
    ).rejects.toThrow(/no way of saying anything back/)
  })

  it('holds together as an intake source before it has looked at anything', () => {
    expect(intakeProblem(githubIssues)).toBeNull()
    expect(githubIssues.intake).toBe('github')
    expect(githubIssues.network).toBe(true)
    // One a look. The schedule's two is a ceiling on agents started, and this
    // one starts work on somebody else's words.
    expect(githubIssues.most).toBe(1)
  })

  it('takes no path, no command and no repository from anybody', () => {
    const keys = Object.keys((githubIssues.input?.properties ?? {}) as object)
    for (const forbidden of ['path', 'file', 'dir', 'root', 'command', 'prompt', 'repository']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('revisions, and the setup a person reads', () => {
  it('compares GitHub revisions as times, and holds what it cannot order', () => {
    expect(newerRevision('github', '2026-09-19T08:00:00Z', '2026-09-19T07:00:00Z')).toBe(1)
    expect(newerRevision('github', '2026-09-19T08:00:00Z', '2026-09-19T08:00:00Z')).toBe(0)
    expect(newerRevision('github', '2026-09-19T07:00:00Z', '2026-09-19T08:00:00Z')).toBe(-1)
    // The whole reason it is not a string comparison. An offset sorts the
    // wrong way round as text — 09:00+02:00 is 07:00Z, which is *earlier* than
    // 08:00Z, and `'…T09'` > `'…T08'` — and the same moment written two ways
    // is the same moment rather than two revisions.
    expect(newerRevision('github', '2026-09-19T09:00:00+02:00', '2026-09-19T08:00:00Z')).toBe(-1)
    expect(newerRevision('github', '2026-09-19T08:00:00.000Z', '2026-09-19T08:00:00Z')).toBe(0)
    // And a spelling that will not parse is not comparable, which holds rather
    // than guessing an order — the third answer, and the one that keeps it
    // honest.
    expect(newerRevision('github', '2026-1-2T00:00:00Z', '2026-01-03T00:00:00Z')).toBeNull()
    expect(newerRevision('github', 'whenever', '2026-09-19T08:00:00Z')).toBeNull()
  })

  it('says what turning it on takes, and only while somebody has not finished', () => {
    const steps = INTAKE_SETUP.github
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.join(' ')).toContain('surfaces.intake.sources.github.from')
    // The sample mapping: the one template Tade ships, and which of its
    // documents the request body goes in.
    expect(steps.join(' ')).toContain('bug-repro-fix-review')
    expect(steps.join(' ')).toContain('document: report')
    expect(intakeUnfinished(grant())).toBeNull()
    expect(intakeUnfinished(grant({ from: [] }))).toBe('nobody is on its list')
    expect(intakeUnfinished(grant({ on: false }))).toContain('enabled is off')
  })
})
