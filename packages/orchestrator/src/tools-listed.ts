import { readFileSync } from 'node:fs'
import type { OrchestratorTool } from './tools-extension.ts'
import { ON_MACHINE } from './tools-remotes.ts'

// Tade's extensions' tools, as the orchestrator is given them: listed when Tade
// started this orchestrator (`writeToolList`), run by Tade, which is where their
// settings, secrets and window are.
//
// **A tool that only reads can name another machine** (`reads` on its spec,
// declared by the extension and never guessed from a name): with `machine` it
// runs on that machine with that machine's own settings and keys — its Sentry
// token, its judge's record — over this machine's owner session there
// (`remote/tool`, `local` in `origin.ts`). Without one it runs here, as it
// always has.
//
// Like everything pi loads, this file imports nothing from the Tade workspace.

/** One tool as Tade listed it. */
interface Listed {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  reads?: true
}

/** The extension tools Tade listed for this orchestrator, or none. */
function listed(): Listed[] {
  const path = process.env.TADE_EXTENSION_TOOLS
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((one) => typeof one?.name === 'string' && typeof one?.parameters === 'object')
      : []
  } catch {
    return []
  }
}

/** What a reading tool's description says it can do besides. */
const ELSEWHERE =
  'Pass `machine` to ask another machine this one is linked to instead: it runs there, with that machine’s own settings and keys.'

/** A reading tool's schema with `machine` beside what it already takes. */
function withMachine(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = (parameters.properties ?? {}) as Record<string, unknown>
  if ('machine' in properties) return parameters
  return { ...parameters, properties: { ...properties, machine: ON_MACHINE } }
}

export function listedTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  return listed().map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.reads ? `${spec.description} ${ELSEWHERE}` : spec.description,
    parameters: spec.reads ? withMachine(spec.parameters) : spec.parameters,
    run: async (p, callId) => {
      const { machine, ...input } = p
      if (spec.reads && typeof machine === 'string' && machine !== '') {
        return rpc('remote/tool', { machine, tool: spec.name, input })
      }
      return rpc('extension/call', { tool: spec.name, input: p, callId })
    },
  }))
}
