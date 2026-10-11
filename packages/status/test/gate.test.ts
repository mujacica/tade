import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { newProbeGate, type ProbeGate } from '../src/gate.ts'
import { type GitProbeResult, gitLoad, probeGit, resolveBase } from '../src/git.ts'

// What the gate is allowed to answer from memory, and what it must always go
// and look at.
//
// Counted in git processes, which is the thing the gate exists to save and the
// only number that means the same on every machine. Never in wall clock: a
// loaded runner makes both halves slower and says nothing about the gate.

const NOW = Date.parse('2026-10-11T12:00:00Z')
const REUSE_MS = 6_000

/** What a look cost, in git processes started. */
async function cost(look: () => Promise<GitProbeResult>) {
  const before = gitLoad().started
  const answer = await look()
  return { answer, spawns: gitLoad().started - before }
}

async function baseOf(root: string) {
  const base = await resolveBase(root)
  if (!base) throw new Error('fixture has no base branch')
  return base
}

/** Asking the same question about the same worktree, at a clock you choose. */
function asking(worktree: string, base: { ref: string; oid: string }, gate: ProbeGate) {
  return (now = NOW, over: { taskBase?: string } = {}) =>
    probeGit(worktree, {
      baseRef: base.ref,
      baseOid: base.oid,
      pr: false,
      gate,
      now,
      ...over,
    })
}

describe('the probe gate', () => {
  it('answers a second look at a worktree nothing happened in without asking git at all', async () => {
    const r = mkrepo()
    const wt = r.addTask('warm', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate())

    const cold = await cost(() => ask())
    const warm = await cost(() => ask())
    expect(cold.spawns).toBeGreaterThanOrEqual(3)
    expect(warm.spawns).toBe(0)
    expect(warm.answer).toEqual(cold.answer)
  })

  it('sees a commit on the very next look', async () => {
    const r = mkrepo()
    const wt = r.addTask('committing', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate())
    await ask()

    r.commit('the work', { 'a.ts': 'x\n' }, wt)
    const after = await cost(() => ask())
    expect(after.spawns).toBeGreaterThanOrEqual(3)
    expect(after.answer.snapshot?.headSubject).toBe('the work')
    expect(after.answer.snapshot?.ahead).toBe(1)
  })

  it('sees a staged file, which moves the index and not the tree', async () => {
    const r = mkrepo()
    const wt = r.addTask('staging', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate())
    await ask()

    r.write({ 'added.ts': 'x\n' }, wt)
    r.git('-C', wt, 'add', 'added.ts')
    const after = await cost(() => ask())
    expect(after.spawns).toBeGreaterThanOrEqual(3)
    expect(after.answer.snapshot?.dirty).toEqual(['added.ts'])
  })

  it('looks again when the base has moved, though the worktree has not', async () => {
    const r = mkrepo()
    const wt = r.addTask('left-behind', { project: 'p' })
    const gate = newProbeGate()
    const before = await baseOf(r.root)
    await cost(() => asking(wt, before, gate)())

    // A commit on main. Nothing in the worktree changed, and the answer about
    // it did: this is a branch that has just been merged, and a gate that
    // could not tell would go on calling it unmerged for as long as you looked.
    r.commit('main moves on')
    const after = await baseOf(r.root)
    expect(after.oid).not.toBe(before.oid)
    const again = await cost(() => asking(wt, after, gate)())
    expect(again.spawns).toBeGreaterThanOrEqual(3)
    expect(again.answer.snapshot?.behind).toBe(1)
  })

  it('looks again within the ceiling for an edit no stat of its own can see', async () => {
    const r = mkrepo()
    const wt = r.addTask('edited', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate({ reuseMs: REUSE_MS }))
    await ask()

    // An edit in place to a file git already tracks: the file's own mtime
    // moves, and `.git/index`, `.git/HEAD` and the worktree directory do not.
    // This is the whole reason the reuse has a ceiling at all.
    r.write({ 'README.md': '# edited\n' }, wt)
    const soon = await cost(() => ask(NOW + 1_000))
    expect(soon.spawns).toBe(0)
    expect(soon.answer.snapshot?.dirty).toEqual([])

    const later = await cost(() => ask(NOW + REUSE_MS + 1))
    expect(later.spawns).toBeGreaterThanOrEqual(3)
    expect(later.answer.snapshot?.dirty).toEqual(['README.md'])
  })

  it('reuses nothing for a clock that has gone backwards', async () => {
    const r = mkrepo()
    const wt = r.addTask('backwards', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate())
    await ask()
    expect((await cost(() => ask(NOW - 1))).spawns).toBeGreaterThanOrEqual(3)
  })

  it('keeps no answer it could not make, and goes on saying what is wrong', async () => {
    const r = mkrepo()
    const wt = r.addTask('taken-away', { project: 'p' })
    const ask = asking(wt, await baseOf(r.root), newProbeGate())
    expect((await ask()).snapshot).not.toBeNull()

    rmSync(wt, { recursive: true, force: true })
    for (const _ of [1, 2]) {
      const look = await cost(() => ask())
      expect(look.spawns).toBeGreaterThanOrEqual(1)
      expect(look.answer.snapshot).toBeNull()
      expect(look.answer.warnings[0]).toMatch(/git status failed/)
    }
  })

  it('never answers a review from memory: a forge moves without the worktree', async () => {
    const r = mkrepo()
    const wt = r.addTask('reviewed', { project: 'p' })
    const base = await baseOf(r.root)
    const gate = newProbeGate()
    const ask = () =>
      probeGit(wt, { baseRef: base.ref, baseOid: base.oid, pr: true, gate, now: NOW })
    expect((await cost(ask)).spawns).toBeGreaterThanOrEqual(3)
    expect((await cost(ask)).spawns).toBeGreaterThanOrEqual(3)
  })

  it('gates nothing when the caller did not say what the base points at', async () => {
    const r = mkrepo()
    const wt = r.addTask('baseless', { project: 'p' })
    const gate = newProbeGate()
    const ask = () => probeGit(wt, { baseRef: 'main', pr: false, gate, now: NOW })
    expect((await cost(ask)).spawns).toBeGreaterThanOrEqual(3)
    expect((await cost(ask)).spawns).toBeGreaterThanOrEqual(3)
  })

  it('forgets the worktree it looked at longest ago, never the one it was just asked about', async () => {
    const r = mkrepo()
    const base = await baseOf(r.root)
    const gate = newProbeGate({ kept: 2 })
    const wts = ['one', 'two', 'three'].map((n) => r.addTask(n, { project: 'p' }))
    for (const wt of wts) await asking(wt, base, gate)()

    // Two held, three asked: the first one out is the one asked about first.
    expect((await cost(() => asking(wts[0]!, base, gate)())).spawns).toBeGreaterThanOrEqual(3)
    expect((await cost(() => asking(wts[2]!, base, gate)())).spawns).toBe(0)
  })

  it('gates nothing for a worktree whose .git says nothing it can follow', async () => {
    const r = mkrepo()
    const wt = r.addTask('broken-pointer', { project: 'p' })
    writeFileSync(join(wt, '.git'), 'this is not a gitdir line\n')
    const ask = () => probeGit(wt, { baseRef: null, pr: false, gate: newProbeGate(), now: NOW })
    // Which is a worktree to look at and say what is wrong with, never one to
    // answer from memory.
    const look = await cost(ask)
    expect(look.spawns).toBeGreaterThanOrEqual(1)
    expect(look.answer.snapshot).toBeNull()
  })

  it('reads a linked worktree’s own HEAD and index, not the checkout’s', async () => {
    const r = mkrepo()
    const one = r.addTask('one', { project: 'p' })
    const two = r.addTask('two', { project: 'p' })
    const base = await baseOf(r.root)
    const gate = newProbeGate()
    await asking(one, base, gate)()
    await asking(two, base, gate)()

    // A commit in one worktree must not make the other look again: they share
    // a `.git` directory and each keeps its own HEAD and index inside it.
    r.commit('only here', { 'b.ts': 'x\n' }, two)
    expect((await cost(() => asking(one, base, gate)())).spawns).toBe(0)
    expect((await cost(() => asking(two, base, gate)())).spawns).toBeGreaterThanOrEqual(3)
  })
})
