import { describe, expect, it } from 'vitest'
import { ExtensionHost, shapeProblem } from './host.ts'
import type { TadeExtension } from './port.ts'

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

    it('reads every setting it is given, and reports one it does not', async () => {
      const host = await load({ settings: { ...(options.settings ?? {}), no_such_setting: 1 } })
      expect(host.list()[0]?.unknownSettings).toEqual(['no_such_setting'])
    })

    it('is ready with what it needs', async () => {
      const host = await load()
      expect(host.list()[0]).toMatchObject({ state: 'ready', problem: null })
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
      }
    })

    it('keeps its sidebar sections cheap, cached and unable to throw', async () => {
      const host = await load()
      const tade = {
        pid: process.pid,
        lanes: () => [],
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
