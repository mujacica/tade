import { chmod, chown, mkdir, stat } from 'node:fs/promises'
import type { Server } from 'node:net'
import { dirname } from 'node:path'

// How private what a launch hands its agent is.
//
// Where the agent runs as Tade's own user, a run's files and its socket are
// Tade's alone: `0700` and `0600`, because the instructions in them carry the
// person's notes. Where it runs as a user of its own (`HarnessOptions.user`),
// Tade's home is closed to it and these are in its share — that user's group,
// set-group-id, Tade in the group — so they are the group's to read and the
// socket the group's to connect to, and still nobody else's. One pair of
// modes, chosen once per adapter, so no file of a run is written the old way
// by a write somebody forgot.

/** The modes a run's folders and files are made with. */
export interface RunModes {
  dir: number
  file: number
}

/** Tade's alone, or Tade's and its agents' group's too. */
export function runModes(shared: boolean): RunModes {
  return shared ? { dir: 0o770, file: 0o640 } : { dir: 0o700, file: 0o600 }
}

/**
 * A folder for sockets, made with those modes: and where it is shared, said
 * again with `chmod`, since `mkdir`'s mode passes through the process's
 * umask and a socket folder the group cannot write in is one whose agent's
 * hooks cannot leave what they could not say (`missed.ts`).
 */
export async function socketFolder(dir: string, shared: boolean): Promise<void> {
  const { dir: mode } = runModes(shared)
  await mkdir(dir, { recursive: true, mode })
  if (!shared) return
  // Whatever special bits it has kept, and set-group-id wherever the share has
  // it: that bit is what gives everything made in it the agents' group, and a
  // bare `0770` takes it away — every socket after that was Tade's own
  // group's, and the agent could not connect to it.
  const has = (await stat(dir)).mode & 0o7000
  const share = (await stat(dirname(dir))).mode & 0o2000
  await chmod(dir, has | share | mode)
}

/**
 * Listen on a Unix socket, and where it is shared let its group connect:
 * connecting to one takes write permission on it, which `listen` leaves to
 * the umask.
 */
export async function listenOn(server: Server, path: string, shared: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  if (!shared) return
  await chmod(path, 0o660)
  // Its folder's group, said outright rather than left to set-group-id: a
  // folder that lost the bit hands a socket Tade's own group, which the agent
  // is not in.
  const { gid } = await stat(dirname(path))
  if ((await stat(path)).gid !== gid) await chown(path, -1, gid)
}
