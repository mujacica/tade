import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type BriefTask,
  composeBrief,
  defaultConfigPath,
  loadConfig,
  tadeHome,
  waitingOn,
} from '@tade/core'
import { loadExtensions, proposedSkills } from '@tade/orchestrator'
import { collectStatus } from '@tade/status'
import { Speaker } from '@tade/voice-tts'
import { readJournal } from '@tade/workbench/events'
import { laneLivenessFromFile } from '@tade/workbench/lane-liveness'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// One paragraph, before the kettle boils. Derived fresh like everything else:
// a brief assembled from what an agent remembers saying would be confidently
// wrong by the second day.

export function registerBrief(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('brief')
    .description('Everything that matters, in one paragraph')
    .option('--speak', 'say it out loud as well as printing it')
    .option('--no-pr', 'skip PR lookups via gh (they hit the network)')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { speak?: boolean; pr: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }

      // What is waiting on a human comes out of the journal, so the brief is
      // the same whether a window is open or not.
      const home = tadeHome()
      const waiting = waitingOn(await readJournal(home))

      {
        const workspace = await collectStatus({
          config: cfg.config,
          now: Date.now(),
          home: homedir(),
          tadeHome: tadeHome(),
          cwd: process.cwd(),
          pr: opts.pr && process.env.TADE_NO_GH !== '1',
          liveness: await laneLivenessFromFile(home),
        })
        const tasks: BriefTask[] = workspace.projects.flatMap((project) =>
          project.tasks.map((task) => ({
            task: task.id,
            state: task.state,
            waiting: waiting.get(task.id) ?? null,
            reason: task.reason,
          })),
        )
        // At most one lesson waiting to be read, and only if the brief is
        // short enough to hear it out: the parameter existed and nothing ever
        // filled it, so Tade proposed things nobody was ever told about.
        const [waitingSkill] = proposedSkills(join(home, 'skills'))
        // What the extensions found — new errors, vulnerable dependencies —
        // said in the same breath, with what to ask about each after it.
        const extensions = await loadExtensions({
          config: cfg.config,
          home,
          safe: program.opts().safe === true,
        })
        const found = await extensions.brief()
        const brief = composeBrief(tasks, {
          localHour: new Date().getHours(),
          extras: found.items.map((item) => item.said),
          ...(waitingSkill
            ? // No full stop: the brief joins its clauses and ends the sentence
              // itself, and two in a row is the sort of thing you hear.
              { proposal: `I wrote down a lesson called ${waitingSkill.name}, worth a look` }
            : {}),
        })
        io.out(brief.spoken)
        const asks = found.items.filter((item) => item.ask)
        if (asks.length > 0) {
          io.out('')
          for (const item of asks) io.out(`→ ${item.ask}`)
        }
        for (const problem of found.problems) io.err(`(could not ask ${problem})`)
        if (opts.speak) {
          const speaker = await Speaker.create({ soundDir: join(tadeHome(), 'sounds') })
          await speaker.speak(brief.spoken)
        }
      }
    })
}
