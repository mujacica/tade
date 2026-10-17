import { describe, expect, it } from 'vitest'
import {
  ATTACHED,
  attachedFrom,
  attachedTo,
  isAttachedLane,
  nextAttached,
} from '../src/attached.ts'
import type { LaneRecord } from '../src/registry.ts'
import { terminalsFrom } from '../src/terminals.ts'

// Terminals that are another machine's agents: lanes here whose id says so,
// found again by the task there they show, and never one of a project's
// terminals — which the orchestrator's tools type commands into.

const lane = (id: string, title: string, over: Partial<LaneRecord> = {}): LaneRecord => ({
  id,
  task: id.split('/').slice(0, 2).join('/'),
  kind: 'terminal',
  spec: { id, cwd: '/home/me', command: 'ssh', args: [] },
  pid: 1,
  startedAt: Number(id.split('/').at(-1)) || 0,
  title,
  alive: true,
  exitCode: null,
  lastOutputAt: null,
  ...over,
})

describe('terminals to another machine’s agents', () => {
  const lanes = [
    lane('remotes/vps/2', 'tade/remote-link'),
    lane('remotes/vps/1', 'tade/intake-door'),
    lane('remotes/vps/3', 'tade/gone', { alive: false }),
    lane('remotes/lab/1', 'firmware/flash'),
    lane('app/terminals/1', 'tests'),
    lane('remotes/vps/agent', 'nobody’s', { kind: 'agent' }),
  ]

  it('are known by their id alone, and only that shape of it', () => {
    expect(isAttachedLane('remotes/vps/1')).toBe(true)
    for (const no of [
      'remotes/vps',
      'remotes/vps/1/x',
      'remotes/VPS/1',
      'app/terminals/1',
      'remotes/vps/agent',
    ])
      expect(isAttachedLane(no), no).toBe(false)
  })

  it('are the live ones, oldest first, with the machine and the task there each shows', () => {
    expect(attachedFrom(lanes).map((one) => [one.id, one.machine, one.task])).toEqual([
      ['remotes/lab/1', 'lab', 'firmware/flash'],
      ['remotes/vps/1', 'vps', 'tade/intake-door'],
      ['remotes/vps/2', 'vps', 'tade/remote-link'],
    ])
  })

  it('keeps one run again in its lane where its tab was, before those opened after it', () => {
    const again = [
      lane('remotes/vps/1', 'tade/intake-door', { startedAt: 30, openedAt: 10 }),
      lane('remotes/lab/1', 'firmware/flash', { startedAt: 20 }),
    ]
    expect(attachedFrom(again).map((one) => one.id)).toEqual(['remotes/vps/1', 'remotes/lab/1'])
  })

  it('finds the one already open to an agent there, and none to an agent on another machine', () => {
    expect(attachedTo(lanes, 'vps', 'tade/remote-link')?.id).toBe('remotes/vps/2')
    expect(attachedTo(lanes, 'lab', 'tade/remote-link')).toBeNull()
    expect(attachedTo(lanes, 'vps', 'tade/gone')).toBeNull()
  })

  it('numbers the next from the lowest no live lane has', () => {
    expect(nextAttached('vps', lanes)).toBe(`${ATTACHED}/vps/3`)
    expect(nextAttached('box', lanes)).toBe(`${ATTACHED}/box/1`)
  })

  it('are never one of a project’s terminals', () => {
    expect(terminalsFrom(lanes).map((one) => one.id)).toEqual(['app/terminals/1'])
  })
})
