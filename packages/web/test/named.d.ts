// The frame and its docks (`src/assets/shell.js`, `src/assets/docks.js`), declared
// for `named.test.ts` — beside `assets.d.ts` rather than in it, as `findings.d.ts`
// is. Only what that test reads of a press: its attributes, its words, its class.

declare module '*/assets/shell.js' {
  type Press = {
    getAttribute(name: string): string | null
    readonly textContent: string | null
    readonly classList: { contains(name: string): boolean }
  }
  export function shell(desk?: unknown): {
    parts: import('../scripts/still-dom.ts').StillNode[]
    links: { figure: { textContent: string | null } }[]
    folds: Record<'menu' | 'side' | 'tade', Press[]>
    asks: Press[]
  }
}

declare module '*/assets/docks.js' {
  export function docksOn(shown: unknown): {
    toggle(which: string, from?: unknown): void
    close(): boolean
  }
}
