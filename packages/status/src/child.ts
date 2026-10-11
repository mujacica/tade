import { type Channel, serveStatus } from './serve.ts'

// The process a window looks at status in. Forked by `lookInChild` and never
// run by hand: it answers asks off its IPC channel until that channel closes.
//
//   node child.ts
//
// It is the window's and dies with it. Not a daemon: a closed channel is a
// window that has gone — quit, crashed or killed outright, which leaves no
// exit path to run and is why this listens rather than being told — and the
// process ends with it. Nothing here can outlive the thing that asked.

if (!process.send) {
  process.stderr.write('status child: run by a window over IPC, not by hand\n')
  process.exit(2)
}
// What `ps` and a task manager call it, rather than `node` and a path: a
// second process beside the window is one somebody will wonder about.
process.title = 'tade status'
process.on('disconnect', () => process.exit(0))
serveStatus(process as Channel)
