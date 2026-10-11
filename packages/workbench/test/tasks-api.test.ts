import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { documentsIn, producedClause, producesPath, taskDir, waitingDocuments } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { sessionIdFor } from '@tade/harnesses-pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { triageDocument } from '../src/documents.ts'
import { Workbench } from '../src/workbench.ts'

// Tasks and runs over the socket: the path the CLI and the orchestrator both
// take. Uses a real repository and a real workbench; only the agent's model is
// absent, so runs start but are never prompted.

const INTENT = 'the refund flow double-charges when the webhook retries'

describe('task and run RPC', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let _socket: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-rpc-')
    // Two agents allowed, so the per-task rule is reachable: with the default
    // of one, `max_parallel` would answer first and the narrower guard would
    // never be exercised.
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n    max_parallel: 2\n`,
    )
    _socket = join(home, 'w.sock')
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('creates a task in the configured project and records the intent verbatim', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })

    expect(task).toMatchObject({ id: 'app/refunds', branch: 'tade/refunds' })
    expect(existsSync(join(taskDir(home, 'app/refunds'), 'task.yaml'))).toBe(true)
    expect(existsSync(join(task.worktree, '.tade'))).toBe(false)

    const [event] = await client.events({ types: ['task_created'] })
    expect(event?.task).toBe('app/refunds')
    expect(event?.detail.intent_spoken).toBe(INTENT)
  })

  it("puts the document in the task's own folder, and tells the orchestrator that path", async () => {
    // The point of the whole mechanism: whoever hears that a research task
    // finished hears where the document is, and the journal is what remembers
    // — a window shut when the agent finished still knows on its way back up.
    // Where it is, is the task's own folder in Tade's home: nothing of this is
    // the project's, so nothing of it is in the checkout or on the branch.
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'notes/scope-audit.md',
    })
    const where = producesPath(home, task.id, 'notes/scope-audit.md')
    expect(where).toBe(join(taskDir(home, 'app/scope-audit'), 'notes', 'scope-audit.md'))
    mkdirSync(join(taskDir(home, 'app/scope-audit'), 'notes'), { recursive: true })
    writeFileSync(where, '# what I found\n')
    // No lane and no agent: where the document is does not depend on knowing
    // where the agent worked, which is the other half of taking it out of the
    // repository.
    await client.markDone(task.id, { by: 'you', summary: 'audit written up' })

    const [done] = await client.events({ types: ['task_done'] })
    expect(done?.detail).toMatchObject({
      by: 'you',
      summary: 'audit written up',
      produces: where,
    })
    expect(done?.detail.missing).toBeUndefined()
    // Nothing was written into the project: no file, and nothing to commit.
    expect(existsSync(join(task.worktree, 'notes', 'scope-audit.md'))).toBe(false)
    // And what the orchestrator is told is that same path, read back out of the
    // journal the way a briefing reads it.
    const [doc] = documentsIn(await client.events({ types: ['task_done'] }))
    expect(doc?.path).toBe(where)
    expect(producedClause(doc!)).toContain(where)
  })

  it('says a task named a document and did not write it, rather than sending anybody to it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'notes/scope-audit.md',
    })
    await client.markDone(task.id, { by: 'you' })

    const [done] = await client.events({ types: ['task_done'] })
    expect(done?.detail).toMatchObject({
      produces: producesPath(home, task.id, 'notes/scope-audit.md'),
      missing: true,
    })
  })

  it('reports a symlink that leaves the task folder as leaving it, and sends nobody to it', async () => {
    // `producesProblem` refuses a *name* that climbs out, but a symlink
    // written inside the folder is a name that passes and a path that does
    // not — and the receipt is handed to whoever reads next as a thing to go
    // and open. So the resolved path is checked against the folder it has to
    // be in, and a receipt never points at somebody's key.
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    const secret = join(home, 'secret.txt')
    writeFileSync(secret, 'not a document\n')
    symlinkSync(secret, producesPath(home, task.id, 'AUDIT.md'))
    await client.markDone(task.id, { by: 'you' })

    const [done] = await client.events({ types: ['task_done'] })
    expect(done?.detail).toMatchObject({ missing: true, outside: true })
    expect(done?.detail.bytes).toBeUndefined()
    // Read back as a task that named a document and wrote none, which is what
    // it is: there is nothing of its own there to read.
    const [doc] = documentsIn(await client.events({}))
    expect(doc?.state).toBe('missing')
  })

  it('says how big a document is, so a huge one can be declined before it is opened', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    writeFileSync(producesPath(home, task.id, 'AUDIT.md'), 'x'.repeat(4096))
    await client.markDone(task.id, { by: 'you' })
    const [done] = await client.events({ types: ['task_done'] })
    expect(done?.detail.bytes).toBe(4096)
    expect(producedClause(documentsIn(await client.events({}))[0]!)).toContain('(4096 bytes)')
  })

  it('says on the removal that a document existed, before the folder holding it goes', async () => {
    // The whole of what went wrong: removing a task is `rm -rf` of the only
    // copy of what it produced, and the removal said nothing about it — so
    // twelve of thirteen documents on one machine were destroyed with no line
    // anywhere saying they had existed, six of them inside two seconds.
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    const where = producesPath(home, task.id, 'AUDIT.md')
    writeFileSync(where, '# what I found\n')
    await client.markDone(task.id, { by: 'you', summary: 'audit written up' })
    await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      task: task.id,
      force: true,
    })

    const [gone] = await client.events({ types: ['task_removed'] })
    expect(gone?.detail).toMatchObject({ produces: where, written: true })
    // And the record outlives the file: the path no longer says where to look,
    // which is exactly why somebody has to be told it was never read.
    expect(existsSync(where)).toBe(false)
    const [doc] = documentsIn(await client.events({}))
    expect(doc).toMatchObject({ task: task.id, path: where, state: 'gone', triaged: null })
  })

  it('speaks for an agent killed before it finished, which never got a receipt', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    writeFileSync(producesPath(home, task.id, 'AUDIT.md'), '# half of what I found\n')
    // No markDone at all: the agent went before it could say anything.
    await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      task: task.id,
      force: true,
    })
    const [doc] = documentsIn(await client.events({}))
    expect(doc).toMatchObject({ state: 'gone', task: task.id })
  })

  it('writes down what somebody decided, and refuses to write a second answer over it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    const where = producesPath(home, task.id, 'AUDIT.md')
    writeFileSync(where, '# what I found\n')
    await client.markDone(task.id, { by: 'you', summary: 'audit written up' })

    const decided = 'nothing follows: the two call sites it names are already guarded'
    const one = await triageDocument(client, { task: task.id, path: where, decided, by: 'person' })
    expect(one.triaged).toMatchObject({ by: 'person', decided })

    // Written down, verbatim, and nothing else happened: no task created, no
    // run started, no setting changed. The only effect is that it stops being
    // listed as waiting.
    const [said] = await client.events({ types: ['document_triaged'] })
    expect(said?.detail).toMatchObject({ path: where, by: 'person', decided })
    expect(await client.events({ types: ['task_created'] })).toHaveLength(1)
    expect(await client.events({ types: ['run_started'] })).toEqual([])
    expect(await client.events({ types: ['config_changed'] })).toEqual([])
    expect(waitingDocuments(documentsIn(await client.events({})), Date.now())).toEqual([])

    // A second one is refused with what the first said: the first is somebody's.
    await expect(
      triageDocument(client, { task: task.id, path: where, decided: 'actually, queue it' }),
    ).rejects.toThrow(decided)
  })

  it('refuses a document no task produced, and one with nothing said about it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'scope-audit',
      intent: 'work out where the token gets taken twice',
      workspace: 'worktree',
      produces: 'AUDIT.md',
    })
    const where = producesPath(home, task.id, 'AUDIT.md')
    writeFileSync(where, '# what I found\n')
    await client.markDone(task.id, { by: 'you' })
    // A path reconstructed from memory rather than read off the list.
    await expect(
      triageDocument(client, { task: task.id, path: '/h/guessed.md', decided: 'fine' }),
    ).rejects.toThrow('is not a document')
    await expect(
      triageDocument(client, { task: task.id, path: where, decided: '   ' }),
    ).rejects.toThrow('say what you decided')
  })

  it('writes no ignore rule into a project, and takes back the one it used to', async () => {
    const path = join(repo.root, '.gitignore')
    await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    // Nothing of Tade's is under the project, so there is nothing to ignore
    // and no file to write: a project Tade has worked in looks untouched.
    expect(existsSync(path)).toBe(false)
    expect(await client.events({ types: ['ignore_removed'] })).toEqual([])

    // And where an older Tade did write one, the next task takes it back out.
    writeFileSync(path, `dist/\n\n# Added by Tade the first time it worked here.\n/.tade/*\n`)
    await client.createTask({ project: 'app', slug: 'search', intent: 'faster search' })
    expect(readFileSync(path, 'utf8')).toBe('dist/\n')
    const [said] = await client.events({ types: ['ignore_removed'] })
    expect(said?.detail.project).toBe('app')
    expect(said?.detail.removed).toEqual(['/.tade/*'])

    // Once, and never again: the third task reads the file and writes nothing.
    await client.createTask({ project: 'app', slug: 'ledger', intent: 'ledger' })
    expect(readFileSync(path, 'utf8')).toBe('dist/\n')
    expect(await client.events({ types: ['ignore_removed'] })).toHaveLength(1)
  })

  it('creates tasks side by side in the checkout, and removing one leaves the checkout alone', async () => {
    const one = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    const two = await client.createTask({ project: 'app', slug: 'search', intent: 'faster search' })
    expect(one).toMatchObject({ workspace: 'checkout', worktree: repo.root, branch: 'main' })
    expect(two.worktree).toBe(repo.root)
    expect(existsSync(join(taskDir(home, 'app/refunds'), 'task.yaml'))).toBe(true)
    await expect(
      client.createTask({ project: 'app', slug: 'refunds', intent: 'again' }),
    ).rejects.toThrow(/used before/)
    const removed = await client.removeTask({
      root: repo.root,
      worktree: one.worktree,
      branch: one.branch,
      task: one.id,
      force: true,
    })
    expect(removed).toEqual({ removed: true, branchDeleted: false })
    expect(existsSync(taskDir(home, 'app/refunds'))).toBe(false)
    expect(existsSync(join(taskDir(home, 'app/search'), 'task.yaml'))).toBe(true)
    expect(existsSync(repo.root)).toBe(true)
  })

  it('never gives a name out twice, even once its task is gone', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      by: 'orchestrator',
    })
    await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      task: task.id,
      force: true,
    })
    // Nothing on disk remembers it, and pi would still carry on its conversation.
    await expect(
      client.createTask({ project: 'app', slug: 'refunds', intent: 'again' }),
    ).rejects.toThrow(/app\/refunds was used before/)
    await client.createTask({ project: 'app', slug: 'a.b', intent: INTENT })
    await expect(
      client.createTask({ project: 'app', slug: 'a-b', intent: INTENT }),
    ).rejects.toThrow(/carry on app\/a\.b's conversation/)
  })

  it('keeps who asked for a task, in its file and in the journal', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'fix',
      intent: INTENT,
      by: 'extension:sentry',
    })
    expect(readFileSync(join(taskDir(home, 'app/fix'), 'task.yaml'), 'utf8')).toContain(
      'by: extension:sentry',
    )
    const [created] = await client.events({ types: ['task_created'] })
    expect(created?.detail.by).toBe('extension:sentry')
  })

  it('runs a task in a harness of its own, and refuses one it has never heard of', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    await expect(
      client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'nope' }),
    ).rejects.toThrow(/no harness called nope/)
    // Every harness in the choices has an adapter behind it; one that is
    // coming and cannot run yet is refused by the same rule, in its own words.
    expect(
      await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'codex' }),
    ).toEqual({ harness: 'codex', restarted: false })
    expect(readFileSync(join(taskDir(home, 'app/refunds'), 'task.yaml'), 'utf8')).toContain(
      'harness: codex',
    )
    expect(
      await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'pi' }),
    ).toEqual({ harness: 'pi', restarted: false })
    expect(readFileSync(join(taskDir(home, 'app/refunds'), 'task.yaml'), 'utf8')).toContain(
      'harness: pi',
    )
  })

  it('offers the models of the harness a task runs in, and nobody else’s', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    const pi = await client.agentModels(task.id, task.worktree)
    expect(pi.harness).toBe('pi')
    // Either a list, or the harness's own words for why there is none —
    // never a fallback to what some other harness runs.
    expect(pi.why === null).toBe(pi.models.length > 0)

    // Claude Code names the model lines it runs itself, and they are not
    // pi's to offer.
    const claude = await client.harnessModels('claude-code')
    expect(claude).toMatchObject({ harness: 'claude-code', why: null })
    expect(claude.models.length).toBeGreaterThan(0)
    for (const model of claude.models) expect(model.provider).toBe('anthropic')

    // And a task moved to that harness is offered exactly those.
    await client.setAgentHarness({
      task: task.id,
      worktree: task.worktree,
      harness: 'claude-code',
    })
    expect(await client.agentModels(task.id, task.worktree)).toEqual(claude)
  })

  it('says a harness it does not run has no models, rather than offering someone’s', async () => {
    expect(await client.harnessModels('nope')).toEqual({
      harness: 'nope',
      models: [],
      why: 'is not a harness Tade runs',
    })
  })

  it('refuses a project it has never heard of', async () => {
    await expect(client.createTask({ project: 'nope', slug: 'x', intent: 'y' })).rejects.toThrow(
      /unknown project/,
    )
  })

  it('removes a finished task and records that too', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    const result = await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })

    expect(result).toMatchObject({ removed: true })
    expect(existsSync(task.worktree)).toBe(false)
    expect((await client.events({ types: ['task_removed'] })).length).toBe(1)
  })

  it('refuses to remove work nobody has merged', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    repo.commit('unmerged work', { 'a.ts': '1' }, task.worktree)

    const result = await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result).toMatchObject({ removed: false, reason: expect.stringContaining('not merged') })
    expect(existsSync(task.worktree)).toBe(true)
    expect(await client.events({ types: ['task_removed'] })).toEqual([])
  })

  it('reports the default posture and no work in flight', async () => {
    expect(await client.runs()).toEqual([])
    expect(await client.pendingApprovals()).toEqual([])
    expect(await client.info()).toMatchObject({ runs: 0, approvals: 'bypass' })
  })

  it('starts an agent in a lane in the task worktree, then stops it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    // No prompt: the agent starts and waits, so this needs no model.
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })

    // The lane, the run and the task are one thing under one name.
    expect(lane).toMatchObject({ id: 'app/refunds/agent', task: 'app/refunds', alive: true })
    // Kept, so a window that finds it again supervises it in the same harness.
    expect(lane.harness).toBe('pi')
    expect((await client.runs()).map((r) => r.run)).toEqual(['app/refunds/agent'])
    expect((await client.info()).runs).toBe(1)

    const [started] = await client.events({ types: ['run_started'] })
    expect(started?.task).toBe('app/refunds')
    expect(started?.detail).toMatchObject({ adapter: 'pi', approvals: 'bypass' })

    await client.stopAgent('app/refunds')
    expect(await client.runs()).toEqual([])
    expect(client.lane('app/refunds/agent' as never)?.alive).toBe(false)
  }, 60_000)

  it('tells a worktree agent to open a review and a checkout agent nothing of the kind', async () => {
    // What a project with nothing configured gets, which is the person's own
    // answer: a worktree is a branch of the agent's own that nobody else is on,
    // so finished work goes up for review, published; a shared checkout has no
    // such branch, so pushing stays a person's and the prompt says nothing
    // about it at all. Here rather than only over `pushFor`, because the answer
    // has to be read off the *task's* workspace — the config says `checkout`
    // for this project either way, and reading it here instead would tell the
    // worktree agent the shared checkout's answer.
    const apart = await client.createTask({
      project: 'app',
      slug: 'apart',
      intent: INTENT,
      workspace: 'worktree',
    })
    await client.startAgent({ task: apart.id, cwd: apart.worktree, prompt: '' })
    const toldApart = (client.lane(`${apart.id}/agent` as never)?.spec.args ?? []).join(' ')
    expect(toldApart).toContain('push your own branch and open a review for it')
    expect(toldApart).toContain('not a draft')

    const together = await client.createTask({
      project: 'app',
      slug: 'together',
      intent: INTENT,
      workspace: 'checkout',
    })
    await client.startAgent({ task: together.id, cwd: together.worktree, prompt: '' })
    const toldTogether = (client.lane(`${together.id}/agent` as never)?.spec.args ?? []).join(' ')
    expect(toldTogether).not.toContain('open a review')
    expect(toldTogether).not.toContain('push')
  }, 60_000)

  it('says the opening instruction once: reopening an agent says nothing to it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    const lane = await client.startAgent({
      task: task.id,
      cwd: task.worktree,
      prompt: 'start with the webhook',
    })
    // Said to the agent once, when it started...
    const launched = (await client.driver.list()).find((one) => one.id === lane.id)
    expect(launched?.spec.args).toContain('start with the webhook')
    // ...and left out of what is written down, which is how it comes back.
    expect(lane.spec.args).not.toContain('start with the webhook')
    expect(readFileSync(join(home, 'lanes.json'), 'utf8')).not.toContain('start with the webhook')

    // The window closed on it, and opens it again where it left off.
    await client.stopAgent(task.id)
    const back = await client.reopenAgent({ task: task.id, cwd: task.worktree })
    const again = (await client.driver.list()).find((one) => one.id === back.id)
    expect(again?.spec.args).not.toContain('start with the webhook')
    // The same conversation, not a new one: the session id is the task's.
    expect(again?.spec.args).toContain(sessionIdFor(task.id))
  }, 60_000)

  it('starts new agents on the model last chosen for one, and a returning one on its own', async () => {
    const sessionsRoot = tmp('tade-sessions-')
    await client.close()
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot })
    client.keepAgentModel('app/refunds', { provider: 'openrouter', id: 'anthropic/claude-opus-5' })
    // Kept where Settings shows the agent model, so the next window starts there too.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('anthropic/claude-opus-5')

    const fresh = await client.createTask({ project: 'app', slug: 'fresh', intent: INTENT })
    const lane = await client.startAgent({ task: fresh.id, cwd: fresh.worktree, prompt: '' })
    expect(lane.spec.args.join(' ')).toContain(
      '--provider openrouter --model anthropic/claude-opus-5',
    )

    // A conversation to come back to keeps the model it was on: pi remembers it.
    const back = await client.createTask({ project: 'app', slug: 'back', intent: INTENT })
    const dir = join(sessionsRoot, '-src-app-')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor('app/back')}.jsonl`),
      '{"type":"session","version":3}\n',
    )
    const returning = await client.startAgent({ task: back.id, cwd: back.worktree, prompt: '' })
    expect(returning.spec.args).not.toContain('--model')
  }, 60_000)

  it('starts new agents as hard-thinking as was last chosen, and refuses a level there is not', async () => {
    await expect(client.setAgentThinking('app/refunds', 'ludicrous')).rejects.toThrow(
      /not a thinking level/,
    )
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n    max_parallel: 2\nworkers:\n  routes:\n    default:\n      thinking: high\n`,
    )
    await client.close()
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    const task = await client.createTask({ project: 'app', slug: 'deep', intent: INTENT })
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    expect(lane.spec.args.join(' ')).toContain('--thinking high')
  }, 60_000)

  it('refuses a second agent on the same task, even when the project allows two', async () => {
    const task = await client.createTask({ project: 'app', slug: 'search', intent: INTENT })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    // Two agents in one worktree is two agents editing the same files.
    await expect(
      client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' }),
    ).rejects.toThrow(/already has an agent/)
  }, 60_000)

  it('forgets an agent whose process ended on its own, so it neither counts nor blocks a restart', async () => {
    const one = await client.createTask({ project: 'app', slug: 'one', intent: INTENT })
    const two = await client.createTask({ project: 'app', slug: 'two', intent: INTENT })
    const lane = await client.startAgent({ task: one.id, cwd: one.worktree, prompt: '' })
    await client.startAgent({ task: two.id, cwd: two.worktree, prompt: '' })
    expect(client.runs()).toHaveLength(2)

    // Nobody stopped it: the process just went, the way a crash or `/quit` does.
    process.kill(lane.pid ?? 0, 'SIGKILL')
    await until(() => client.runs().length === 1)
    expect(client.runs().map((run) => run.task)).toEqual([two.id])
    const exited = await until(
      async () => (await client.events({ types: ['run_exited'], task: one.id }))[0],
    )
    expect(exited?.detail).toHaveProperty('code')

    // Its slot is free, and the same task starts again rather than "run already exists".
    await expect(
      client.startAgent({ task: one.id, cwd: one.worktree, prompt: '' }),
    ).resolves.toMatchObject({ id: `${one.id}/agent` })
  }, 90_000)

  it('refuses more agents than the project allows', async () => {
    for (const slug of ['one', 'two']) {
      const task = await client.createTask({ project: 'app', slug, intent: INTENT })
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    }
    const third = await client.createTask({ project: 'app', slug: 'three', intent: INTENT })
    await expect(
      client.startAgent({ task: third.id, cwd: third.worktree, prompt: '' }),
    ).rejects.toThrow(/max_parallel is 2/)
  }, 90_000)
})

describe('a config that names a setting Tade no longer has', () => {
  let home: string
  let client: Workbench

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('opens on it and says which key is ignored, rather than refusing the file', async () => {
    const repo = mkrepo()
    home = tmp('tade-gone-')
    writeFileSync(
      join(home, 'config.yaml'),
      `workers:\n  routes:\n    default: { model: claude-opus-5, sandbox: seatbelt }\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9' })
    // Everything beside it still applies: refusing the file would have taken
    // the project and the model with it.
    expect(client.config.projects.app?.root).toBe(repo.root)
    expect(client.config.workers.routes.default?.model).toBe('claude-opus-5')
    const said = (await client.events({ types: ['warning'] })).map((e) =>
      String(e.detail.message ?? ''),
    )
    // And the person is told, because a key that quietly does nothing is one
    // somebody goes on believing in.
    expect(said.some((line) => line.includes('workers.routes.default.sandbox is ignored'))).toBe(
      true,
    )
    expect(said.some((line) => line.includes('sandboxes are gone from Tade'))).toBe(true)
  })
})
