import { DaemonClient } from '@wilco/daemon/client'
import { socketPath } from '@wilco/daemon/protocol'
import { Exit, type Io } from './io.ts'

/**
 * Run something against the daemon, or explain why we can't. Commands never
 * throw at the user: a missing daemon and a failed call both become a line on
 * stderr and an exit code.
 */
export async function withDaemon(
  io: Io,
  setExit: (code: number) => void,
  fn: (client: DaemonClient) => Promise<void>,
): Promise<void> {
  let client: DaemonClient
  try {
    client = await DaemonClient.connect(socketPath())
  } catch {
    io.err('daemon not running: start it with `wilco daemon start`')
    setExit(Exit.error)
    return
  }
  try {
    await fn(client)
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    setExit(Exit.error)
  } finally {
    await client.close()
  }
}
