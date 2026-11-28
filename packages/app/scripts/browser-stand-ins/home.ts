// What a browser drawing the golden scenarios is handed in place of
// `@tade/core`'s `home.ts` (`browser-goldens.ts` swaps the one for the other),
// which asks Node where the home directory is. The config's schema expands a
// project's `~/…` root with `expandHome`, and the Settings page types it back
// with `typedHome`; a page has no home directory, so it stands in one no
// machine has, and the two undo each other as they do in Node under any home
// — which is all a golden, drawn the same on every machine, can depend on.
//
// The two `config.ts` and `settings-projects.ts` import, and no others: a
// scenario reaching another is a page error naming it.

const HOME = '/a-browser-has-no-home'

export function expandHome(p: string): string {
  if (p === '~') return HOME
  return p.startsWith('~/') ? `${HOME}/${p.slice(2)}` : p
}

export function typedHome(p: string): string {
  if (p === HOME) return '~'
  return p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p
}
