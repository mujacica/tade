// Where the page is, read out of the address bar.
//
// **Two screens and a full view.** The page is the overview — the machines,
// the four tiles, the agents waiting on you and working, and the conversation
// with Tade — and the pairing screen a device without a session is shown.
// Everything else Tade can show is a panel of the window, which is the full
// view at `/draw/` (§10 T5 of the Duo plan): an agent tapped on the overview
// opens there (`agentPath`), never on a second agent page of this one's.
//
// **Every view here is a path in `src/routes.ts`.** A client route the server
// does not serve is a screen that works until somebody reloads it and then
// 404s, which is the worst kind of broken — it passes every test that never
// reloads. `test/routes-client.test.ts` asserts the two tables name the same
// paths, in both directions.
//
// No hash routing: the fragment is where the pairing ticket lives, and a
// router that owned it would put a one-use credential into every navigation.
//
// Nothing here touches the DOM.

/**
 * Which screen a path is, or `nowhere`.
 *
 * `nowhere` is a real answer and the page draws it: a path the server served
 * the shell for but this router does not know is a version mismatch — an old
 * bookmark of a page that went — and saying so beats drawing the overview and
 * pretending the link worked.
 */
export function viewOf(path) {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return { view: 'now' }
  if (trimmed === '/pair') return { view: 'pair' }
  return { view: 'nowhere' }
}

/** The screens with a path of their own, held equal to the server's document routes. */
export const PLAIN = ['pair']

/** The path for a screen, which is what goes in an `href` and in the history. */
export function pathOf(where) {
  return where.view === 'now' ? '/' : `/${where.view}`
}

/** Where the window keeps the mark of another machine's id (`there.ts` in `@tade/app`). */
const THERE_MARK = '@'
const THERE_SEP = '\u001f'

/**
 * The full view, opened on one agent: what a tap on its row on the overview
 * does. `id` is the task's `<project>/<task>`; another machine's agent carries
 * that machine in front of it, as the window's own rows do (`there.ts`).
 */
export function agentPath(id, machine = '') {
  const named = machine === '' ? id : `${THERE_MARK}${machine}${THERE_SEP}${id}`
  return `/draw/?agent=${encodeURIComponent(named)}`
}

/**
 * What the heading and the document title say.
 *
 * The title is announced by a screen reader on navigation, so it is the one
 * place the view's name has to be a sentence rather than a tab label.
 */
export const TITLES = {
  now: 'Overview',
  pair: 'Pair this device',
  nowhere: 'Nothing here',
  // **Two views that are not places.** `nowhere` is a path this router does
  // not know and `lastSeen` is a cold open with nothing answering — neither
  // has a path of its own, neither can be linked to. They are here because a
  // `<title>` is owed for every screen somebody can be looking at, and
  // `test/routes-client.test.ts` names them as the two it does not expect the
  // server to serve.
  lastSeen: 'Last seen',
}

/**
 * Which page's own files draw a view: `pages/<page>.js` builds it and
 * `pages/<page>.css` styles it, and the router puts `page-<page>` on the
 * screen's root so every rule in that sheet is scoped under it
 * (`test/pages.test.ts`). A view with no entry is drawn by a shared module.
 */
export const PAGE_OF = {
  now: 'overview',
}
