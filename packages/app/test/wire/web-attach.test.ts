import type { LaneId } from '@tade/core'
import type { AttachOptions, WorkspaceCapabilities } from '@tade/drivers-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { attachingFor, insideTheWindow, NOT_RUNNING } from '../../src/wire/web-attach.ts'

// This machine's half of one of its agents opened from another machine's
// window: the driver's own line for the agent's lane as a pane, asked of the
// driver and never built here — or why there is none.

const TMUX: WorkspaceCapabilities = {
  detach: true,
  remoteAttach: true,
  nativeTabs: true,
  focus: true,
  setTitle: true,
  adopt: true,
  pointer: true,
}

/** The three things the answer reads, as a workbench with these lanes would answer them. */
function client(over: { driver?: string; remoteAttach?: boolean; alive?: readonly string[] } = {}) {
  const asked: { lane: string; options: AttachOptions | undefined }[] = []
  const alive = new Set(over.alive ?? [])
  const one: Pick<Workbench, 'info' | 'lane' | 'attachCommand'> = {
    info: () =>
      ({
        driver: over.driver ?? 'tmux',
        capabilities: { ...TMUX, remoteAttach: over.remoteAttach ?? true },
      }) as ReturnType<Workbench['info']>,
    lane: (id: LaneId) =>
      ({ id, alive: alive.has(id) }) as unknown as ReturnType<Workbench['lane']>,
    attachCommand: (lane: LaneId, options?: AttachOptions) => {
      asked.push({ lane, options })
      return `attach ${lane}`
    },
  }
  return { one, asked }
}

describe('the line for one of this machine’s agents, asked from another', () => {
  it('is the driver’s own, for the task’s agent lane, as a pane', () => {
    const { one, asked } = client({ alive: ['far/fix-it/agent'] })
    expect(attachingFor(one)('far/fix-it')).toEqual({ command: 'attach far/fix-it/agent' })
    expect(asked).toEqual([{ lane: 'far/fix-it/agent', options: { embedded: true } }])
  })

  it('says the agent is not running rather than handing a line to nothing', () => {
    const { one, asked } = client({ alive: [] })
    expect(attachingFor(one)('far/fix-it')).toEqual({ command: null, why: NOT_RUNNING })
    expect(asked).toEqual([])
  })

  it('says where the agents are when no other terminal can reach them, by what the driver declares', () => {
    const { one, asked } = client({
      driver: 'pty',
      remoteAttach: false,
      alive: ['far/fix-it/agent'],
    })
    expect(attachingFor(one)('far/fix-it')).toEqual({ command: null, why: insideTheWindow('pty') })
    expect(asked).toEqual([])
  })
})
