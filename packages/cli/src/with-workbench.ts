import { tadeHome } from '@tade/core'
import { HomeBusyError, Workbench } from '@tade/workbench'
import { Exit, type Io } from './io.ts'

/**
 * Run something against the workbench, or explain why we can't.
 *
 * Opening it claims the home directory, so a command run while a window is
 * open is refused rather than left to interleave its writes with the window's.
 * Commands never throw at the user: every failure is a line on stderr and an
 * exit code.
 */
export async function withWorkbench(
  io: Io,
  setExit: (code: number) => void,
  fn: (tade: Workbench) => Promise<void>,
): Promise<void> {
  let tade: Workbench
  try {
    tade = await Workbench.open({ home: tadeHome() })
  } catch (err) {
    io.err(
      err instanceof HomeBusyError
        ? `${err.message}. Ask it there, or close it first.`
        : err instanceof Error
          ? err.message
          : String(err),
    )
    setExit(Exit.error)
    return
  }
  try {
    await fn(tade)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    setExit(Exit.error)
  } finally {
    // Closing lets go of the lanes; it does not stop them.
    await tade.close().catch(() => {})
  }
}
