import { describe, expect, it } from 'vitest'
import { ExtensionHost } from './host.ts'
import type { TadeExtension } from './port.ts'
import { intakeProblem, shapeProblem } from './shape.ts'

// The suite every extension passes, built-in or yours. It asserts the
// contract around an extension rather than what it finds: that it is put
// together so a harness can offer its tools, that asking whether it is ready
// or what it would tell a model never throws, and that a tool called without
// what it needs is refused with the reason before it runs.

export interface ConformanceOptions {
  /** Settings under `extensions.<name>` that make it ready. */
  settings?: Record<string, unknown>
  /** An environment that makes it ready: a token, say. */
  env?: Record<string, string | undefined>
  /** Answers instead of the network. The suite must never reach it. */
  fetch?: typeof fetch
  /** A project root it can read. */
  project?: string
}

export function extensionConformance(
  make: () => TadeExtension,
  options: ConformanceOptions = {},
): void {
  const extension = make()
  const offline: typeof fetch = async (input) => {
    throw new Error(`the conformance suite reached the network: ${String(input)}`)
  }
  const load = (
    overrides: {
      settings?: Record<string, unknown>
      env?: Record<string, string | undefined>
    } = {},
  ) =>
    ExtensionHost.load({
      builtin: [make()],
      config: {
        extensions: { [extension.name]: overrides.settings ?? options.settings ?? {} },
        projects: options.project ? { here: { root: options.project } } : {},
      },
      home: options.project ?? '/nonexistent',
      env: overrides.env ?? options.env ?? {},
      fetch: options.fetch ?? offline,
    })

  describe(`${extension.name} (extension conformance)`, () => {
    it('is put together so a harness can offer it', async () => {
      expect(shapeProblem(extension)).toBeNull()
      for (const linker of (await load()).linkers()) {
        expect(() => new RegExp(linker.pattern)).not.toThrow()
      }
    })

    it('says what it needs, rather than throwing, when nothing is set up', async () => {
      const host = await load({ settings: {}, env: {} })
      const [loaded] = host.list()
      expect(loaded?.state).not.toBe('broken')
      if (loaded?.state === 'needs setup') expect(loaded.problem).toBeTruthy()
    })

    it('says whether it is ready without reaching the network, whatever the answer', async () => {
      // `ready()` is asked on every look at the Settings page and before the
      // window opens. One that dialled would make drawing a poll — and one
      // that dialled and swallowed what came back would look exactly like one
      // that did not, which is why this counts rather than waits for a throw.
      const tried: string[] = []
      for (const settings of [options.settings ?? {}, {}]) {
        const host = await ExtensionHost.load({
          builtin: [make()],
          config: {
            extensions: { [extension.name]: settings },
            projects: options.project ? { here: { root: options.project } } : {},
          },
          home: options.project ?? '/nonexistent',
          env: options.env ?? {},
          fetch: (async (input: unknown) => {
            tried.push(String(input))
            throw new Error('nothing here dials')
          }) as typeof fetch,
        })
        expect(tried).toEqual([])
        // And it answered rather than falling over on the way.
        expect(host.list()[0]?.state).not.toBe('broken')
      }
    })

    it('reads every setting it is given, and reports one it does not', async () => {
      const host = await load({ settings: { ...(options.settings ?? {}), no_such_setting: 1 } })
      expect(host.list()[0]?.unknownSettings).toEqual(['no_such_setting'])
    })

    it('is ready with what it needs', async () => {
      const host = await load()
      expect(host.list()[0]).toMatchObject({ state: 'ready', problem: null })
    })

    it('says how it is used, in whole lines, and hands them on as it wrote them', async () => {
      // The Extensions page is where somebody finds out what an extension is
      // for, and a page that has only the one-line blurb is how people come to
      // believe an extension does whatever its one watch does. What it says
      // here is what is shown, unedited.
      const host = await load()
      expect(host.list()[0]?.workflow).toEqual(extension.workflow ?? [])
      for (const line of extension.workflow ?? []) expect(line.trim()).not.toBe('')
    })

    it('tells the orchestrator and agents about itself without throwing', async () => {
      const host = await load()
      expect(host.orchestratorPrompt()).toContain(extension.title)
      expect(() =>
        host.agentPrompt({ name: 'here', root: options.project ?? '/nonexistent' }),
      ).not.toThrow()
    })

    it('refuses a tool call missing what it needs, before the tool runs', async () => {
      const host = await load()
      for (const tool of extension.tools ?? []) {
        const required = Array.isArray(tool.parameters.required)
          ? (tool.parameters.required as string[])
          : []
        if (required.length === 0) continue
        await expect(
          host.call(tool.name, {}, { caller: { kind: 'orchestrator' } }),
        ).rejects.toThrow(/is needed/)
      }
    })

    it('offers each tool only to who it says', async () => {
      const host = await load()
      const agentTools = host.specs('agent').map((spec) => spec.name)
      const orchestratorTools = host.specs('orchestrator').map((spec) => spec.name)
      for (const tool of extension.tools ?? []) {
        expect(agentTools.includes(tool.name)).toBe(tool.for.includes('agent'))
        expect(orchestratorTools.includes(tool.name)).toBe(tool.for.includes('orchestrator'))
      }
    })

    it('offers its watches to be turned on, and refuses input they do not take', async () => {
      const host = await load()
      const offered = host.watches()
      for (const watch of extension.watches ?? []) {
        const id = `${extension.name}.${watch.id}`
        expect(offered.find((one) => one.id === id)).toMatchObject({ problem: null })
        const required = Array.isArray(watch.input?.required)
          ? (watch.input.required as string[])
          : []
        if (required.length === 0) expect(host.watchProblem(id, {})).toBeNull()
        else expect(host.watchProblem(id, {})).toMatch(/is needed/)
        // One that is on without anybody turning it on is turned on by a
        // rule, and a rule has nothing of its own to say: it has to take
        // being asked for with nothing.
        if (watch.standing) expect(required).toEqual([])
        // Declared, never sniffed, in both directions: what the host offers
        // about a watch is what the watch said about itself, so nobody has to
        // discover a capability by calling it and seeing what happens.
        const offer = offered.find((one) => one.id === id)
        expect(offer?.intake).toBe(watch.intake ?? null)
        expect(offer?.rechecks).toBe(typeof watch.recheck === 'function')
        expect(offer?.replies).toBe(typeof watch.reply === 'function')
      }
    })

    it('can be asked whether what it found still stands, where it takes work in', async () => {
      // An intake source makes work out of somebody else's words, and the
      // queue asks it again at the moment of starting — so one that cannot
      // answer would make work nothing could ever start. The rule is enforced
      // at the door that turns a watch on, which is asserted here rather than
      // described: a source that cannot be rechecked is refused by name.
      const host = await load()
      for (const watch of extension.watches ?? []) {
        if (watch.intake === undefined) continue
        const id = `${extension.name}.${watch.id}`
        // Nothing about *being an intake source* may refuse it. Asked of the
        // capability rather than of `watchProblem`, because a source may also
        // require an input — a repository's label, a board — and "you have not
        // said which label" is a door working rather than a broken source.
        expect(intakeProblem(watch)).toBeNull()
        expect(typeof watch.recheck).toBe('function')
        // A source asked about something it has never heard of has verified
        // nothing, and the one answer it must not give is that the request
        // still stands. Throwing is right — an inaccessible or unknown source
        // is a hold — and so is saying no with a reason; `true` is not.
        const answer = await host
          .recheck(id, { project: 'here', input: {}, key: 'nothing:no-such-thing:0' })
          .catch(() => null)
        if (answer) expect(answer.still).toBe(false)
      }
    })

    it('says one status at most once, and keeps looking when it cannot write', async () => {
      // A reply is a capability honoured by absence, and the whole of what a
      // transport owes is here: it posts the sentence it was handed, it
      // recognises its own marker, and a write it cannot do is an ordinary
      // error that stops nothing else.
      const host = await load()
      for (const watch of extension.watches ?? []) {
        const id = `${extension.name}.${watch.id}`
        const ask = (): Promise<unknown> =>
          host.reply(id, {
            project: 'here',
            input: {},
            key: 'nothing:no-such-thing:0',
            say: 'Picked up.',
            mark: 'tade:nothing:no-such-thing:noticed',
          })
        if (!options.project) {
          // These options gave no project, so no watch door opens at all —
          // and what must still be true is that nothing posts: a door that
          // cannot be opened refuses rather than quietly succeeding. What the
          // capability *is* was asserted where it is declared.
          await expect(ask()).rejects.toThrow()
          continue
        }
        if (typeof watch.reply !== 'function') {
          // No reply at all is a stronger guarantee than one that is off, and
          // the door says so rather than quietly doing nothing: a status that
          // silently went nowhere is the failure this path must not have.
          await expect(ask()).rejects.toThrow(/no way of saying anything back/)
          continue
        }
        const first = await ask().catch((err: unknown) => err)
        if (first instanceof Error) {
          // **Unavailable writes, while reads still work.** No credential and
          // no network is exactly what this suite has, so a transport that
          // reaches one cannot post here — and that must be an ordinary error
          // with a sentence on it, never something that takes the look down
          // with it. The request still gets built; nobody is told.
          expect(first.message).toBeTruthy()
          const looked = await host
            .look(id, {
              project: 'here',
              input: {},
              since: null,
              turnedOn: new Date(0).toISOString(),
            })
            .catch(() => null)
          if (looked) expect(Array.isArray(looked.found)).toBe(true)
          continue
        }
        // A receipt is an object even when there is nothing to put in it: a
        // source whose revision moves when something is posted to it has to be
        // able to say where it moved to, and `void` is a transport that can
        // never answer that (`REPLIES_MOVE_REVISIONS`).
        expect(typeof first).toBe('object')
        // **Idempotent by the marker.** Asked again with the same one — which
        // is what a window that died between posting and writing its line
        // does — it creates nothing and says the source already has it.
        const again = (await ask()) as { already?: boolean }
        expect(again.already).toBe(true)
      }
    })

    it('keeps its sidebar sections cheap, cached and unable to throw', async () => {
      const host = await load()
      const tade = {
        pid: process.pid,
        lanes: () => [],
        agents: () => [],
        startAgent: async () => ({ task: 'here/none', worktree: '/nonexistent' }),
      }
      const sections = await host.lists(tade)
      expect(sections.map((one) => one.id)).toEqual(
        (extension.lists ?? []).map((list) => `${extension.name}.${list.id}`),
      )
      for (const section of sections) {
        // A section that could not be filled says why on itself: the window
        // draws one quiet row, and nothing else stops.
        expect(section.problem === null || typeof section.problem === 'string').toBe(true)
        for (const row of section.rows) {
          expect(row.id).toBeTruthy()
          expect(row.title).toBeTruthy()
        }
        const ids = section.rows.map((row) => row.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
      // Asked again inside its own interval, it is the same answer and
      // nothing was asked of anybody: drawing is never a poll.
      expect(await host.lists(tade)).toEqual(sections)
    })

    it('takes its credentials from the config, and from the environment first', async () => {
      const declared = (extension.settings ?? []).filter((setting) => setting.kind === 'secret')
      if (declared.length === 0) return
      const host = await load()
      for (const setting of declared) {
        const listed = host.secrets().find((one) => one.key === setting.key)
        expect(listed).toMatchObject({ path: `extensions.${extension.name}.${setting.key}` })
        // A credential is a setting: written into the config it is the one
        // that is used, drawn back as itself, and never reported as a key
        // nobody reads.
        const inConfig = await load({
          settings: { ...(options.settings ?? {}), [setting.key]: 'pasted-into-the-config' },
          // Nothing exported: the environment wins, and what is under test
          // here is what happens when it has nothing to say.
          env: {},
        })
        expect(inConfig.list()[0]?.unknownSettings ?? []).not.toContain(setting.key)
        const written = inConfig.secrets().find((one) => one.key === setting.key)
        expect(written?.value).toBe('pasted-into-the-config')
        expect(written?.from).toBe('config.yaml')
        // And what the environment says is what is used, whatever is written.
        const [variable] = typeof setting.env === 'string' ? [setting.env] : (setting.env ?? [])
        if (!variable) continue
        const fromEnv = await load({
          settings: { ...(options.settings ?? {}), [setting.key]: 'pasted-into-the-config' },
          env: { [variable]: 'from-the-shell' },
        })
        expect(fromEnv.secrets().find((one) => one.key === setting.key)?.from).toBe(`$${variable}`)
      }
      // What the shell holds stays in the shell: it is said as a place.
      expect(JSON.stringify(host.secrets())).not.toContain('from-the-shell')
    })

    it('reads a command an agent is held at without ever loosening it', async () => {
      if (!extension.caution) return
      const asking = {
        project: 'here',
        task: 'here/work',
        worktree: options.project ?? '/nonexistent',
        tool: 'bash',
        command: 'rm -rf /',
        input: { command: 'rm -rf /' },
        decided: { tier: 'soft' as const, rule: 'command', reason: 'runs a command' },
        signal: new AbortController().signal,
      }
      // An agent is waiting on this, so it is asked of an extension that is
      // set up and of one that is not, and neither may throw: nothing here is
      // allowed to be the reason a turn ends.
      for (const host of [await load(), await load({ settings: {}, env: {} })]) {
        const read = await host.caution(asking)
        if (!read.caution) continue
        // There is no answer here that allows anything, and the tier is one
        // of the two that ask.
        expect(['soft', 'hard']).toContain(read.caution.tier)
        expect(read.caution.reason.trim().length).toBeGreaterThan(0)
        expect(read.caution.by).toBe(extension.name)
      }
    })

    it('says why a watch cannot look when it is not set up, rather than looking', async () => {
      const host = await load({ settings: {}, env: {} })
      if (host.list()[0]?.state === 'ready') return
      for (const watch of extension.watches ?? []) {
        await expect(
          host.look(`${extension.name}.${watch.id}`, {
            project: 'here',
            input: {},
            since: null,
            turnedOn: new Date(0).toISOString(),
          }),
        ).rejects.toThrow(host.list()[0]?.problem ?? /./)
      }
    })
  })
}
