import { ExtensionHost } from '@tade/extensions-core'
import { jevExtension } from '../src/extension.ts'

// Jev, answered the way TypeSafe answers or by a table, and never over the
// network: what is under test is what Tade asks, what it makes of the answer,
// and that with no key none of it runs.
//
// One harness for both test files, because two of them drift: the day the fake
// stops matching what the client sends is the day the tests stop meaning
// anything, and it is better to find that out in one place.

export const NOW = Date.parse('2026-09-20T09:00:00Z')

/** A TypeSafe that answers exactly what a test tells it to, and 0.02 otherwise. */
export function typesafe(answers: Record<string, number>, seen?: unknown[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: unknown
      questions: Record<string, { type: string; criteria?: unknown }>
    }
    seen?.push(body)
    return Response.json({
      model: 'jev-1.13.0',
      usage: { input_tokens: 500 },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          if (question.type === 'noul') return [id, { type: 'noul', noul: answers[id] ?? 0.02 }]
          if (question.type === 'choice') {
            const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
            return [
              id,
              {
                type: 'choice',
                choice: options[0],
                probabilities: Object.fromEntries(
                  options.map((one, at) => [one, at === 0 ? 0.9 : 0.1]),
                ),
                confidence: 0.8,
              },
            ]
          }
          const levels = (question.criteria ?? []) as string[]
          return [
            id,
            {
              type: 'score',
              score: answers[id] ?? 1,
              probabilities: Object.fromEntries(levels.map((level) => [level, 1 / levels.length])),
              confidence: 0.5,
            },
          ]
        }),
      ),
    })
  }) as typeof fetch
}

export const offline: typeof fetch = async (input) => {
  throw new Error(`it reached the network: ${String(input)}`)
}

export function host(options: {
  home: string
  projects?: Record<string, { root: string }>
  settings?: Record<string, unknown>
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** A fixed instant, or `Date.now` where the fixture's own commits are the clock. */
  now?: number | (() => number)
}) {
  return ExtensionHost.load({
    builtin: [jevExtension],
    config: {
      extensions: { jev: options.settings ?? {} },
      projects: options.projects ?? {},
    },
    home: options.home,
    env: options.env ?? {},
    fetch: options.fetch ?? offline,
    now: clock(options.now),
  })
}

/** A fixed instant, a live clock, or the default — always as something to call. */
function clock(now: number | (() => number) | undefined): () => number {
  if (typeof now === 'function') return now
  const at = now ?? NOW
  return () => at
}
