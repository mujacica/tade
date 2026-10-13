// The spend page's pure half (`src/assets/pages/spend-shape.js`), declared for
// `spend-client.test.ts` — beside `assets.d.ts` rather than in it, so the page
// that owns the module owns its declaration. Loose for `assets.d.ts`'s reason:
// a second typed description of a projected row would be a second schema that
// nothing holds to `protocol.ts`.

declare module '*/assets/pages/spend-shape.js' {
  type Fold = {
    usd: number
    usdExact: number
    usdEstimated: number
    usdListed: number
    usdOnPlan: number
    tokens: number
    tokensUnpriced: number
    tokensOnPlanUnrated: number
    hasCost: boolean
    unknown: number
    partial: boolean
  }
  type Cell = { value: string | null; word: string }
  type Lead = {
    fold: Fold
    billed: Cell & { parts: { key: string; said: string; word: string }[] }
    onPlan: Cell
    tokens: Cell
  }
  type Bar = {
    key: string
    label: string
    href: string | null
    value: number | null
    said: string
    kind: 'money' | 'plan' | 'none' | 'tokens'
    under: string
    tone: string
    unrecorded: boolean
  }
  type Went = { measure: 'cost' | 'tokens'; rows: Bar[]; quiet: number; quietSaid: string }
  type Card = {
    key: string
    harness: string
    account: string | null
    name: string
    kind: 'windows' | 'cannot' | 'silent' | 'per-token'
    windows: {
      key: string
      label: string
      share: number
      said: string
      pressure: 'fine' | 'warm' | 'tight'
      resets: string
      under: string
    }[]
    tightest: number | null
    pressure: 'fine' | 'warm' | 'tight' | null
    line: string
  }

  export const MARKS: Record<string, string>
  export const MADE_OF: Record<string, string>
  export const GROUPS: { key: string; word: string; noun: [string, string] }[]
  export const UNRECORDED: string
  export function spentAny(fold: Fold): boolean
  export function moneySaid(fold: Fold): string | null
  export function onPlanSaid(fold: Fold): string | null
  export function noMoneyWhy(fold: Fold, granted: boolean): string
  export function leadOf(tasks: readonly any[], opts: { granted: boolean; partial: boolean }): Lead
  export function periodOf(since: string | null | undefined, now: number): string | null
  export function wentOf(tasks: readonly any[], by: string, opts?: { partial?: boolean }): Went
  export function plansShape(rows: readonly any[], now: number): Card[]
  export function pressureSaid(card: Card): string
}
