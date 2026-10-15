import type { LaneId } from '@tade/core'
import { makeCollector, type StatusAsk, type StatusCollector } from '@tade/status'
import { describe, expect, it } from 'vitest'
import { openerForLink } from '../../src/editor.ts'
import { type FakeTerminal, until, windowUnderTest } from './harness.ts'

// What the side says of where the work is, read through the whole window.

/**
 * The look the window makes anyway, with the refunds agent's lane listening on
 * `ports` — what status puts on a lane once `lsof` has found its dev server —
 * and every ask it was handed, so a test can say what the window asked for.
 */
function listening(ports: number[], asks: StatusAsk[]): StatusCollector {
  const look = makeCollector('here')
  return {
    id: 'listening',
    async collect(ask) {
      asks.push(ask)
      const answer = await look.collect(ask)
      if (!answer.known) return answer
      for (const project of answer.workspace.projects) {
        for (const task of project.tasks) {
          if (task.id !== 'app/refunds') continue
          const lane = {
            id: 'app/refunds/agent' as LaneId,
            kind: 'agent' as const,
            alive: true,
            pid: 1,
            lastOutputAt: null,
            attach: '',
            ports,
          }
          task.lanes = [...task.lanes, lane]
        }
      }
      return answer
    },
    close: () => look.close(),
  }
}

describe('the window, and where the work is', () => {
  let terminal: FakeTerminal
  const { start, click, find, opened, sidebar } = windowUnderTest((wired) => {
    terminal = wired.terminal
  })

  it('links the page an agent’s dev server serves under GIT, and a click opens it', async () => {
    // Wide enough for a side that has room for the host as well as the port.
    terminal.columns = 120
    terminal.rows = 60
    const asks: StatusAsk[] = []
    // A dev server, and Postgres beside it: only one of them is a page.
    await start({ status: listening([5173, 5432], asks) })
    await until('the link', () => sidebar().includes('serving  localhost:5173 ↗'))
    expect(sidebar()).not.toContain('5432')
    // The window asks for the ports on its own beat; how often they are
    // really looked at is status's to hold (`PORTS_MS`).
    expect(asks.every((ask) => ask.ports === true)).toBe(true)

    const link = find('localhost:5173')
    click(link.col + 2, link.row)
    await until('the browser it would have opened', () => opened.length > 0)
    const { command, args } = openerForLink('http://localhost:5173')
    expect(opened).toEqual([{ command, args }])
  })

  it('keeps the port where the side has no room for the host', async () => {
    terminal.columns = 80
    terminal.rows = 60
    await start({ status: listening([5173], []) })
    await until('the port', () => sidebar().includes('serving  :5173 ↗'))
  })

  it('draws no link for an agent whose lanes serve no page', async () => {
    terminal.rows = 60
    await start({ status: listening([5432], []) })
    await until('the side', () => sidebar().includes('GIT'))
    await until('the branch under it', () => sidebar().includes('branch'))
    expect(sidebar()).not.toContain('serving')
  })
})
