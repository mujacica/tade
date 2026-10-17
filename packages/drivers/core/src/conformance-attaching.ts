import type { LaneId } from '@tade/core'
import { spawn as openPty } from 'node-pty'
import { expect, it } from 'vitest'
import type { AttachOptions, LaneSpec, WorkspaceDriver } from './port.ts'
import { until } from './waiting.ts'

// What the suite asks of `attachCommand`: the escape hatch that makes the rest
// safe to rely on — whatever else is broken, a human can still see the lane —
// and the far half of a lane on another machine drawn as a pane of this
// machine's window (REMOTE-TADE.md §3.4). Apart from `conformance.ts` so both
// have room; run from inside it, with its driver and its lanes — and, like it,
// never shipped: it imports vitest (`conformance-*.ts`, `NOT_SHIPPED` in
// `scripts/release/stage.ts`).

/** What the suite hands over: the driver of this test, a fresh lane's spec, and a wait on its screen. */
export interface Attaching {
  driver(): WorkspaceDriver
  spec(): LaneSpec
  waitFor(id: LaneId, text: string): Promise<unknown>
}

const utf8 = new TextEncoder()
const line = (s: string) => utf8.encode(`${s}\n`)

/** A terminal of its own running `command`, and everything it has shown so far. */
function terminal(command: string, cols = 80, rows = 24) {
  const seen: string[] = []
  const term = openPty('/bin/sh', ['-c', command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  })
  term.onData((chunk) => seen.push(chunk))
  return { term, shown: () => seen.join('') }
}

export function testAttaching(at: Attaching): void {
  const attach = (id: LaneId, options?: AttachOptions) => at.driver().attachCommand(id, options)

  it('attachCommand names the lane and is non-empty', async () => {
    const s = at.spec()
    await at.driver().open(s)
    const cmd = attach(s.id)
    expect(cmd.length).toBeGreaterThan(0)
    expect(cmd).toContain(s.id.split('/').at(-1)!)
  })

  // A string that looks plausible and does not run is worse than no escape
  // hatch at all, because you find out at the moment you needed it — so it
  // gets run.
  //
  // Gated on `remoteAttach`, which is exactly the claim that the command
  // works from another terminal with no Tade in the picture. A driver
  // without it hands back something like `tade attach <lane>`, which needs
  // the window that owns the lane and cannot be tested from out here.
  it('attachCommand actually attaches, not just reads like it would', async () => {
    if (!at.driver().capabilities.remoteAttach) return
    const s = at.spec()
    await at.driver().open(s)
    await at.waitFor(s.id, 'ready')
    await at.driver().write(s.id, line('marker'))
    await at.waitFor(s.id, 'got:marker')
    const viewer = terminal(attach(s.id))
    try {
      // What the lane already said has to show up in somebody else's
      // terminal, which is the whole claim.
      await until(() => viewer.shown().includes('got:marker'))
    } finally {
      viewer.term.kill()
    }
  })

  it('two terminals attached to one lane see the same thing', async () => {
    if (!at.driver().capabilities.remoteAttach) return
    const s = at.spec()
    await at.driver().open(s)
    await at.waitFor(s.id, 'ready')
    const a = terminal(attach(s.id))
    const b = terminal(attach(s.id))
    try {
      await at.driver().write(s.id, line('shared'))
      // Neither is privileged: one attacher is a view, not an owner.
      await until(() => a.shown().includes('got:shared'))
      await until(() => b.shown().includes('got:shared'))
    } finally {
      a.term.kill()
      b.term.kill()
    }
  })

  // Two agents opened at once are two panes. `tmux attach` puts both terminals
  // on one session, whose current window is one for all of them: the second
  // moved the first to its own lane, and the two panes showed one agent.
  it('two terminals attached to two lanes each show their own, and leave both running', async () => {
    if (!at.driver().capabilities.remoteAttach) return
    const one = at.spec()
    const two = at.spec()
    await at.driver().open(one)
    await at.driver().open(two)
    await at.waitFor(one.id, 'ready')
    await at.waitFor(two.id, 'ready')
    const a = terminal(attach(one.id, { embedded: true }))
    await until(() => a.shown().includes('ready'))
    const b = terminal(attach(two.id, { embedded: true }))
    try {
      await until(() => b.shown().includes('ready'))
      await at.driver().write(one.id, line('first'))
      await at.driver().write(two.id, line('second'))
      await until(() => a.shown().includes('got:first'))
      await until(() => b.shown().includes('got:second'))
      expect(a.shown()).not.toContain('got:second')
    } finally {
      a.term.kill()
      b.term.kill()
    }
    // A terminal going away is somebody closing a pane, or a connection
    // dropping: never the lane. On tmux 3.4 the obvious way of tidying up
    // after one ended the whole server, every lane on it.
    for (const s of [one, two]) {
      await at.driver().write(s.id, line('after'))
      await at.waitFor(s.id, 'got:after')
    }
  })

  // Embedded is a pane of another window: every key is the lane's, a backend's
  // own prefix key included (ctrl+b, which tmux keeps by default and which
  // turns the `t` after it into a clock), and the lane is drawn at the size of
  // the pane rather than cut to the size it was opened at.
  it('an embedded terminal hands the lane every key and its own size', async () => {
    if (!at.driver().capabilities.remoteAttach) return
    const s = at.spec()
    await at.driver().open(s)
    await at.waitFor(s.id, 'ready')
    const pane = terminal(attach(s.id, { embedded: true }), 100, 30)
    try {
      await until(() => pane.shown().includes('ready'))
      await at.waitFor(s.id, 'size 100x30')
      pane.term.write('\x02typed\r')
      await at.waitFor(s.id, 'got:typed')
    } finally {
      pane.term.kill()
    }
  })
}
