// The pages an agent's dev servers serve, as presses out of the page: in the
// bar of an agent's page, and of its project's for every agent in it.
//
// **The wire carries ports, never an address** (`TaskRow.servers`). Which host
// reaches this machine is the page's own — the one it was opened at — so a
// page opened on this machine opens `localhost`, and one opened on a phone
// opens the machine it is talking to. A server bound to this machine alone
// answers only here, and nothing on the wire could say which it is.

import { el, into, keyed } from './dom.js'
import { icon } from './icons.js'

/** Every port these tasks are serving a page on, once each and in order. Pure. */
export function servedBy(tasks) {
  const ports = new Set()
  for (const task of tasks) for (const port of task.servers ?? []) ports.add(port)
  return [...ports].sort((a, b) => a - b)
}

/**
 * Where a page opened at `at` finds the server on `port`: its own host, over
 * plain http (a dev server's), at the top. Null where the page knows no
 * address of its own to start from. Pure.
 */
export function servedAt(port, at) {
  if (typeof at !== 'string' || at === '') return null
  const url = new URL('/', at)
  url.protocol = 'http:'
  url.port = String(port)
  return url.href
}

/** A press per port, in the bar's tools: written once, then kept in step (`update`). */
export function servingIn(tools) {
  const node = el('span', { class: 'pg-serving' })
  into(tools, node)
  // The page's own address, which every link starts from; none, and there is nothing to link.
  const at = globalThis.location?.href ?? ''
  return {
    update(ports) {
      keyed(
        node,
        at === '' ? [] : ports,
        (port) => String(port),
        (port) => {
          const link = el('a', {
            class: 'ui-chip',
            text: `:${port}`,
            attrs: {
              href: servedAt(port, at),
              target: '_blank',
              rel: 'noopener noreferrer',
              'aria-label': `Open what port ${port} is serving`,
            },
          })
          into(link, icon('arrow'))
          return link
        },
        () => {},
      )
    },
  }
}
