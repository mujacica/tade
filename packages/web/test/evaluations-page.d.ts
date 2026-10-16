// The Evaluations page's pure half (`src/assets/pages/evaluations-shape.js`),
// declared for `evaluations-client.test.ts` — beside `assets.d.ts` rather than
// in it, so the page that owns the module owns its declaration. Loose for
// `assets.d.ts`'s reason: the answer it reads is `EvaluationsOut`, held by the
// machine's own types, and a second description of it here would be a second
// schema.

declare module '*/assets/pages/evaluations-shape.js' {
  type Box = { kind: string; title: string; line: string }
  type Bar = {
    key: string
    label: string
    value: number
    said: string
    under: string
    tone?: string
  }
  type Tile = { key: string; label: string; value: string | null; under: string }
  export const EVAL_TABS: { id: string; word: string }[]
  export function mergedSaid(answer: unknown): string
  export function costSaid(cost: unknown): string | null
  export function findingsSaid(found: unknown): string | null
  export function leadOf(answer: unknown): Tile[]
  export function cardsOf(answer: unknown, by: string): Bar[]
  export function underOf(row: unknown, granted: unknown): string
  export function judgeOf(answer: unknown): {
    state: string
    said?: string
    questions?: Bar[]
    bands?: Bar[]
  }
  export function boxOf(kind: string, title: string, line: string): Box
  export function emptyOf(answer: unknown, by: string): Box | null
}
