// What the command bar offers for what has been typed — pure, and no DOM.
//
// **The command bar and the conversation are one input** (Raycast's rule):
// whatever is typed is first a message to Tade, where this device may send
// one, and then a filter over what could be done and where to go — the acts
// this device was granted on the work that matches, every screen, every open
// project, every piece of work that wants somebody and every agent running.
// Enter takes the row that is lit, and the first row is the message.
//
// **Nothing here is permission.** The message row is offered off `talk.mine`
// and an act row off the task's own `can` list and this session's scopes —
// both drawing hints. The machine re-asks the scope, the setting, the origin,
// the project and the state when the act arrives, and every other row is a
// link to a screen the page would draw anyway.

/** How many rows of each group are shown, so a machine with ninety tasks is still a list. */
export const GROUP_MOST = 6

/** How many presses the bar offers at once: the best-named work's, before anywhere to go. */
export const DO_MOST = 4

/** How many places the bar remembers having gone to. */
export const RECENT_MOST = 5

/**
 * How well a label answers what was typed, and which of its characters did.
 *
 * Lower is better and null is not at all: a prefix beats a word inside, which
 * beats anywhere inside, which beats the letters in order with gaps — so `se`
 * finds `sentry` before `queue-settings`, and `qrs` still finds `queue-rules`.
 * `at` is the indices that matched, which a row carries as `match` for the bar to light.
 */
export function matchOf(label, query) {
  const said = label.toLowerCase()
  const want = query.trim().toLowerCase()
  if (want === '') return { score: 4, at: [] }
  const run = (from) => Array.from({ length: want.length }, (_, n) => from + n)
  if (said.startsWith(want)) return { score: 0, at: run(0) }
  const word = [...said.matchAll(/(^|[\s/._-])(?=\S)/g)]
    .map((one) => one.index + one[1].length)
    .find((start) => said.startsWith(want, start))
  if (word !== undefined) return { score: 1, at: run(word) }
  const inside = said.indexOf(want)
  if (inside >= 0) return { score: 2, at: run(inside) }
  const at = []
  let from = 0
  for (const char of want) {
    if (char === ' ') continue
    const found = said.indexOf(char, from)
    if (found < 0) return null
    at.push(found)
    from = found + 1
  }
  return { score: 3, at }
}

/** The score alone, for whoever only needs to sort. */
export function scoreOf(label, query) {
  return matchOf(label, query)?.score ?? null
}

/**
 * The rows for what has been typed, in the order they are drawn.
 *
 * `from` is plain data out of the store — the screens with their keys, the open
 * projects' names, the tasks worth jumping to with their states, titles and the
 * acts that may be asked of each, the places gone to lately, the
 * conversation's standing — so this can be held to its behaviour by a test
 * with no page. A task is found by its id or by its title, and lit by
 * whichever matched.
 */
export function commandsFor(query, from) {
  const typed = query.trim()
  const rows = []
  const talk = from.talk ?? null
  if (typed !== '' && talk !== null && talk.mine === true && talk.busy !== true) {
    rows.push({ kind: 'ask', group: 'Tade', label: typed, icon: 'spark', match: [], key: 'ask' })
  }
  const add = (group, row) => rows.push({ group, ...row })
  const pick = (items) => {
    const scored = []
    for (const item of items) {
      const own = matchOf(item.label, typed)
      const alt = item.alt === undefined || item.alt === null ? null : matchOf(item.alt, typed)
      const best =
        own !== null && (alt === null || own.score <= alt.score)
          ? { ...own, on: 'label' }
          : alt === null
            ? null
            : { score: alt.score + 0.5, at: alt.at, on: 'alt' }
      if (best !== null) scored.push({ ...item, score: best.score, match: best })
    }
    scored.sort((a, b) => a.score - b.score || a.rank - b.rank)
    return scored.slice(0, GROUP_MOST)
  }

  // **What can be done**, only once something was typed — or, with nothing
  // typed, only on the work that wants somebody: an empty bar is a place to go
  // from, and a list of every press on every task is not that.
  const tasks = (from.tasks ?? []).map((task, rank) => ({
    ...task,
    label: task.id,
    alt: task.title,
    rank,
  }))
  // A loose match — the letters in order — finds a place to go but never
  // offers a press: an act is only offered on work that was plainly named.
  const doable = pick(typed === '' ? tasks.filter((task) => task.wants === true) : tasks).filter(
    (task) => typed === '' || task.score < 3,
  )
  const acts = []
  for (const task of doable) {
    for (const act of task.acts ?? []) {
      acts.push({
        kind: act.verb === 'steer' ? 'tell' : 'act',
        verb: act.verb,
        typed: act.typed ?? {},
        task: task.id,
        label: act.word,
        sub: task.id,
        icon: act.icon,
        tone: act.tone ?? '',
        match: [],
        key: `do:${task.id}:${act.verb}:${act.word}`,
      })
    }
  }
  for (const one of acts.slice(0, DO_MOST)) add('Do', one)

  if (typed === '') {
    for (const one of (from.recent ?? []).slice(0, RECENT_MOST)) {
      add('Recent', {
        kind: 'go',
        label: one.label,
        icon: one.icon ?? 'clock',
        path: one.path,
        match: [],
        key: `recent:${one.path}`,
      })
    }
  }

  for (const one of pick(tasks)) {
    add('Work', {
      kind: 'go',
      label: one.label,
      sub: one.title ?? '',
      icon: one.icon ?? 'bolt',
      path: one.path,
      tone: one.tone ?? '',
      match: one.match.on === 'label' ? one.match.at : [],
      key: `go:${one.path}`,
    })
  }
  for (const one of pick(
    (from.projects ?? []).map((name, rank) => ({
      label: name,
      icon: 'folder',
      path: `/p/${encodeURIComponent(name)}`,
      rank,
    })),
  )) {
    add('Projects', {
      kind: 'go',
      label: one.label,
      icon: one.icon,
      path: one.path,
      match: one.match.at,
      key: `go:${one.path}`,
    })
  }
  for (const one of pick((from.screens ?? []).map((screen, rank) => ({ ...screen, rank })))) {
    add('Go to', {
      kind: 'go',
      label: one.label,
      icon: one.icon,
      path: one.path,
      hint: one.hint ?? '',
      match: one.match.at,
      key: `go:${one.path}`,
    })
  }
  // One row per place: a recent place is not offered again under its group.
  const seen = new Set()
  return rows.filter((row) => {
    if (row.kind !== 'go') return true
    if (seen.has(row.path)) return false
    seen.add(row.path)
    return true
  })
}

/** The next lit row for an arrow key, wrapping, or -1 for a list with nothing in it. */
export function movedTo(at, rows, by) {
  if (rows <= 0) return -1
  return (((at + by) % rows) + rows) % rows
}

/**
 * The places gone to lately, newest first, with this one in front.
 *
 * A per-viewer convenience held for as long as the page is open, never a record:
 * a path and the word it was called, nothing of the work.
 */
export function rememberedWith(recent, one) {
  const rest = (recent ?? []).filter((each) => each.path !== one.path)
  return [{ path: one.path, label: one.label, icon: one.icon }, ...rest].slice(0, RECENT_MOST)
}

/** The label split into what was typed and what was not, for the bar to light. */
export function litOf(label, at) {
  const lit = new Set(at)
  const parts = []
  for (let n = 0; n < label.length; n += 1) {
    const on = lit.has(n)
    const last = parts.at(-1)
    if (last !== undefined && last.on === on) last.text += label[n]
    else parts.push({ text: label[n], on })
  }
  return parts
}
