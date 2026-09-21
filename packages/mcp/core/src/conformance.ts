import type { TadeExtension } from '@tade/extensions-core'
import { shapeProblem } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { nameProblem, namesFor, prefixFor } from './naming.ts'
import {
  type CallContext,
  McpError,
  type McpTransport,
  type ServerDeclaration,
  type TransportContext,
} from './port.ts'

// The shared suites every transport and every brokered extension must pass,
// written before either of them.
//
// They assert the contract, never the content: what a server offers is the
// server's business. What they do assert is what this feature could get
// catastrophically wrong — a window that hangs on somebody else's program, a
// call that throws where it should answer, and a third party filling in parts
// of a Tade extension that were never theirs to fill in.
//
// Nothing in either suite reaches the network, and the `fetch` handed to a
// transport throws if anything tries.

export interface TransportConformanceOptions {
  /** One that works and offers at least one tool, one of which is `fails`. */
  works: ServerDeclaration
  /** The tool on `works` whose call the server itself calls a failure. */
  fails: string
  /** One whose open never answers, so the deadline is what ends it. */
  hangs?: ServerDeclaration
  /** One that is not here at all, for what `ready()` says to do about it. */
  missing?: ServerDeclaration
  /** One that answers with rubbish: dropped, never thrown over. */
  noisy?: ServerDeclaration
  /** A tool on `works` that takes long enough to be given up on mid-call. */
  lingers?: string
  /** How long an open may take here. */
  deadlineMs?: number
  /** Anything this transport needs of its context: a home, an environment. */
  context?(): Partial<TransportContext>
}

export function testTransport(
  name: string,
  make: () => McpTransport,
  options: TransportConformanceOptions,
): void {
  const offline: typeof fetch = async (input) => {
    throw new Error(`the conformance suite reached the network: ${String(input)}`)
  }
  const context = (extra: Partial<TransportContext> = {}): TransportContext => ({
    home: '/nonexistent',
    credential: null,
    env: {},
    fetch: offline,
    now: () => 0,
    deadlineMs: options.deadlineMs ?? 2_000,
    ...options.context?.(),
    ...extra,
  })
  const calling = (): CallContext => ({
    signal: new AbortController().signal,
    progress: () => {},
  })

  describe(`${name} (transport conformance)`, () => {
    it('says what it can do here, rather than leaving anybody to guess from its name', () => {
      const transport = make()
      expect(transport.id).toBeTruthy()
      for (const key of ['spawns', 'network', 'announces', 'cancel'] as const) {
        expect(typeof transport.capabilities[key], key).toBe('boolean')
      }
    })

    it('answers whether it could talk to a server without dialling it', async () => {
      const transport = make()
      // `ready()` is asked on every look at the page, so it answers from the
      // declaration, the filesystem and the credential — never from a dial.
      await expect(transport.ready(options.works, context())).resolves.toBeNull()
    })

    it('says what to do about one that is not here, rather than throwing', async () => {
      if (!options.missing) return
      const transport = make()
      const said = await transport.ready(options.missing, context())
      expect(said).toBeTruthy()
      expect(said?.length ?? 0).toBeGreaterThan(10)
    })

    it('opens, says what the server offers, and every tool it offers can be shaped', async () => {
      const transport = make()
      const session = await transport.open(options.works, context())
      try {
        expect(session.about.title).toBeTruthy()
        const tools = await session.listTools()
        expect(tools.length).toBeGreaterThan(0)
        for (const tool of tools) {
          expect(typeof tool.name).toBe('string')
          expect(typeof tool.description).toBe('string')
          expect(typeof tool.input).toBe('object')
        }
      } finally {
        await session.close()
      }
    })

    it('answers a call, and a call the server calls a failure is still an answer', async () => {
      const transport = make()
      const session = await transport.open(options.works, context())
      try {
        const tools = await session.listTools()
        const first = tools[0]
        if (!first) throw new Error('the suite needs a server that offers something')
        const ok = await session.callTool(first.name, {}, calling())
        expect(typeof ok.text).toBe('string')
        // A server saying no is an answer a model reads and picks another
        // route from. Only not being able to ask at all is a throw.
        const bad = await session.callTool(options.fails, {}, calling())
        expect(bad.failed).toBe(true)
        expect(bad.text.trim()).not.toBe('')
      } finally {
        await session.close()
      }
    })

    it('refuses a tool the server never offered, rather than inventing a call', async () => {
      const transport = make()
      const session = await transport.open(options.works, context())
      try {
        await expect(session.callTool('no_such_tool_here', {}, calling())).rejects.toThrow(McpError)
      } finally {
        await session.close()
      }
    })

    it('abandons an open that does not answer, rather than waiting on it', async () => {
      if (!options.hangs) return
      const transport = make()
      const started = Date.now()
      const deadline = 200
      await expect(
        transport.open(options.hangs, context({ deadlineMs: deadline })),
      ).rejects.toMatchObject({ trouble: 'timeout' })
      // Nothing draws while this waits, so what matters is that it ends.
      expect(Date.now() - started).toBeLessThan(deadline + 2_000)
    })

    it('drops what it cannot make sense of, rather than throwing over it', async () => {
      if (!options.noisy) return
      const transport = make()
      const session = await transport.open(options.noisy, context())
      try {
        await expect(session.listTools()).resolves.toBeInstanceOf(Array)
      } finally {
        await session.close()
      }
    })

    it('gives up on a call it is told to give up on', async () => {
      if (!options.lingers) return
      const transport = make()
      const session = await transport.open(options.works, context())
      const controller = new AbortController()
      try {
        const call = session.callTool(
          options.lingers,
          {},
          { signal: controller.signal, progress: () => {} },
        )
        controller.abort()
        // Either it comes back refused or it comes back as an answer; what it
        // may never do is stay out there with an agent waiting on it.
        await call.then(
          (outcome) => expect(typeof outcome.text).toBe('string'),
          (err: unknown) => expect(err).toBeInstanceOf(McpError),
        )
      } finally {
        await session.close()
      }
    })

    it('closes twice without complaining, and refuses a call afterwards with why', async () => {
      const transport = make()
      const session = await transport.open(options.works, context())
      await session.close()
      await session.close()
      await expect(session.callTool(options.fails, {}, calling())).rejects.toMatchObject({
        trouble: 'gone',
      })
    })

    it('only ever says it was told the list changed where it says it can be', async () => {
      const transport = make()
      const session = await transport.open(options.works, context())
      try {
        // Whether the listener is ever called is the server's business; that
        // the seam exists and unsubscribing works is the port's.
        const stop = session.onToolsChanged(() => {})
        expect(typeof stop).toBe('function')
        stop()
      } finally {
        await session.close()
      }
    })
  })
}

/**
 * The other half: what the broker is allowed to produce.
 *
 * > **A brokered extension fills in `tools`, and nothing else.**
 *
 * One rule, which closes a dozen holes at once — no watch a third party gets
 * a clock and an agent from, no words of theirs in the briefing or the status
 * bar or the search box, no regex of theirs over everything on screen, no
 * code of theirs loaded into every agent, and nothing of theirs answering
 * Tade's own gate. It is asserted here so it cannot be relaxed by accident.
 */
export function brokeredConformance(name: string, made: () => readonly TadeExtension[]): void {
  /** Everything a Tade extension can be, that a brokered one may never fill in. */
  const forbidden = [
    'watches',
    'brief',
    'status',
    'view',
    'lists',
    'actions',
    'caution',
    'meant',
    'linkers',
    'harness',
    'setup',
    'root',
  ] as const

  describe(`${name} (brokered extension conformance)`, () => {
    it('fills in tools, and nothing else', () => {
      for (const extension of made()) {
        for (const key of forbidden) {
          expect(extension[key], `${extension.name}.${key}`).toBeUndefined()
        }
      }
    })

    it('is put together so every harness can offer it', () => {
      for (const extension of made()) {
        expect(shapeProblem(extension), extension.name).toBeNull()
        expect(extension.name.startsWith('mcp-'), extension.name).toBe(true)
        expect((extension.tools ?? []).length, extension.name).toBeGreaterThan(0)
      }
    })

    it('names every tool after its server, and never after one of Tade’s own', () => {
      for (const extension of made()) {
        const prefix = prefixFor(extension.name.slice('mcp-'.length))
        for (const tool of extension.tools ?? []) {
          expect(tool.name.startsWith(prefix), tool.name).toBe(true)
          expect(nameProblem(tool.name), tool.name).toBeNull()
        }
      }
    })

    it('offers every tool to agents and the orchestrator alike, which is one namespace', () => {
      for (const extension of made()) {
        for (const tool of extension.tools ?? []) {
          expect([...tool.for].sort(), tool.name).toEqual(['agent', 'orchestrator'])
        }
      }
    })

    it('says whose words these are, in a sentence Tade wrote', () => {
      for (const extension of made()) {
        const said = `${extension.description} ${(extension.workflow ?? []).join(' ')}`
        expect(said, extension.name).toContain('nobody here wrote')
      }
    })

    it('declares its credential as a secret, so it is never in the config', () => {
      for (const extension of made()) {
        for (const setting of extension.settings ?? []) {
          expect(setting.kind, `${extension.name}.${setting.key}`).toBe('secret')
        }
      }
    })
  })
}

/** What a server offered, named the way a harness will see it. For a suite to check against. */
export function namedFor(server: string, tools: Parameters<typeof namesFor>[1]): string[] {
  return namesFor(server, tools)
    .map((one) => one.name)
    .filter((one): one is string => one !== null)
}
