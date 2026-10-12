// What the command bar offers for what has been typed — pure, and no DOM.
//
// **The command bar and the conversation are one input** (Raycast's rule):
// whatever is typed is first a message to Tade, where this device may send
// one, and then a filter over where it could go — every screen, every open
// project, every piece of work that wants somebody and every agent running.
// Enter takes the row that is lit, and the first row is the message.
//
// **Nothing here is permission.** The message row is offered off `talk.mine`,
// which is a drawing hint read off this device's own session: the machine
// re-asks the scope, the setting and the origin when the message arrives. And
// every other row is a link to a screen the page would draw anyway, so a row
// this device could not read leads to the screen saying so, never to more.

/** How many rows of each group are shown, so a machine with ninety tasks is still a list. */
export const GROUP_MOST = 6

/**
 * How well a label answers what was typed: lower is better, null is not at all.
 *
 * A prefix beats a word inside the label, which beats anywhere — so `se`
 * finds `sentry` before `queue-settings`, and `set` finds `Settings` first.
 */
export function scoreOf(label, query) {
  const said = label.toLowerCase()
  const want = query.toLowerCase()
  if (want === '') return 3
  if (said.startsWith(want)) return 0
  if (said.split(/[\s/._-]+/).some((word) => word.startsWith(want))) return 1
  if (said.includes(want)) return 2
  return null
}

/**
 * The rows for what has been typed, in the order they are drawn.
 *
 * `from` is plain data out of the store — the screens, the open projects'
 * names, the tasks worth jumping to with their states, the conversation's
 * standing — so this can be held to its behaviour by a test with no page.
 */
export function commandsFor(query, from) {
  const typed = query.trim()
  const rows = []
  const talk = from.talk ?? null
  if (typed !== '' && talk !== null && talk.mine === true && talk.busy !== true) {
    rows.push({ kind: 'ask', group: 'Tade', label: typed, icon: 'spark', key: 'ask' })
  }
  const pick = (group, items) => {
    const scored = []
    for (const item of items) {
      const score = scoreOf(item.label, typed)
      if (score !== null) scored.push({ ...item, score })
    }
    scored.sort((a, b) => a.score - b.score || a.rank - b.rank)
    for (const one of scored.slice(0, GROUP_MOST)) {
      rows.push({
        kind: 'go',
        group,
        label: one.label,
        icon: one.icon,
        path: one.path,
        tone: one.tone ?? '',
        key: `${group}:${one.path}`,
      })
    }
  }
  pick(
    'Work',
    (from.tasks ?? []).map((task, rank) => ({
      label: task.id,
      icon: task.icon ?? 'bolt',
      path: task.path,
      tone: task.tone,
      rank,
    })),
  )
  pick(
    'Projects',
    (from.projects ?? []).map((name, rank) => ({
      label: name,
      icon: 'folder',
      path: `/p/${encodeURIComponent(name)}`,
      rank,
    })),
  )
  pick(
    'Go to',
    (from.screens ?? []).map((screen, rank) => ({ ...screen, rank })),
  )
  return rows
}

/** The next lit row for an arrow key, wrapping, or -1 for a list with nothing in it. */
export function movedTo(at, rows, by) {
  if (rows <= 0) return -1
  return (((at + by) % rows) + rows) % rows
}
