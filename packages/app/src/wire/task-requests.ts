import { takeTaskRequests } from '@tade/workbench/task-requests'
import { withTranscript } from '../model.ts'
import { problem } from '../transcript.ts'
import type { Wiring } from './context.ts'

// The tasks a terminal asked for while this window holds the journal — `tade
// task create` on a server whose `tade serve` is running — made here, on the
// beat, through the workbench's own `createTask`, so every `task_created` line
// is numbered by the one writer there is (`task-requests.ts` in the workbench
// says why). What one made is seen on the next look like any other task, and
// one made to start is started by the queue's rule, never by this.

export class TaskRequests {
  private readonly wire: Wiring
  /** One take at a time: making a task runs git, which can take longer than a beat. */
  private taking = false
  /** What stopped the last take, so a beat that finds it again says nothing. */
  private trouble: string | null = null

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /** Make whatever a terminal has asked for since the last beat, and answer it. */
  async beat(): Promise<void> {
    if (this.taking) return
    this.taking = true
    try {
      const client = this.wire.opts.client
      const { taken, trouble } = await takeTaskRequests(this.wire.opts.home, (request) =>
        client.createTask(request),
      )
      if (trouble !== null && trouble !== this.trouble) {
        const line = `A task a terminal asked for could not be made here: ${trouble}`
        this.wire.put(
          withTranscript(
            this.wire.state,
            problem(this.wire.state.transcript, line, this.wire.now()),
          ),
        )
        this.wire.draw()
      }
      this.trouble = trouble
      if (taken > 0) void this.wire.live?.lookAgain()
    } finally {
      this.taking = false
    }
  }
}
