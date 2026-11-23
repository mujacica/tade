// One agent's changes page's pure half (`src/assets/pages/agent-changes-shape.js`),
// declared for `changes-client.test.ts` — beside `assets.d.ts` rather than in
// it, so the page that owns the module owns its declaration. Loose for
// `assets.d.ts`'s reason: a second typed answer would be a second schema that
// nothing holds to `changes.ts`.

declare module '*/assets/pages/agent-changes-shape.js' {
  type File = {
    path: string
    mark: string
    added: number | null
    removed: number | null
    says: string
    text: string | null
    taken: number
  }
  type Answer = { says: string; base?: string | null; files: File[] }
  type State = { kind: string; title: string; line: string | null; icon?: string }
  export function lineKind(line: string): 'hunk' | 'add' | 'del' | 'meta' | 'same'
  export function diffRows(text: string | null): { line: string; kind: string }[]
  export const MARKS: Readonly<Record<string, string>>
  export function markWord(mark: string): string
  export function countSaid(added: number | null, removed: number | null): string
  export function figureOf(answer: Answer | null): string
  export function fileSaid(file: Pick<File, 'says'>): string | null
  export function takenSaid(file: Pick<File, 'taken'>): string | null
  export function stateFor(answer: Answer | null, failed: string | null): State | null
}
