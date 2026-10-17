import { trustFolder } from './trust.ts'

// Answering Claude Code's folder question as the user its agent runs as.
//
// Where an agent runs as a user of its own (`agents.user`), Claude Code's
// state file is in that user's home, which Tade cannot write in — so the
// launch line, which already runs as that user, answers it with this just
// before Claude Code starts (`LAUNCHER`): the same answer, under the same lock,
// that `trustFolder` gives in Tade's own home. Run as
// `node trust-here.ts <folder> <config folder>`; never throws, because a
// question left unanswered is a dialog in the lane, which is where things were.

const [folder, configDir] = process.argv.slice(2)
if (folder && configDir) {
  await trustFolder(folder, configDir).catch((err: unknown) => {
    process.stderr.write(
      `tade: could not mark ${folder} as trusted for Claude Code, so it will ask: ${(err as Error).message}\n`,
    )
  })
}
