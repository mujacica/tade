---
name: run-the-checks
description: How to run a project's own checks through Tade before committing or pushing — what the ids mean, how to read a failing tail, and what to do when a failure is not yours.
---

# Running the checks

1. **Ask Tade to run them, not your shell.** `checks_run` takes the worktree's lock, so several
   agents in one checkout never start several suites at once — which is what makes the suite time
   out and look like a regression it is not. It records what ran against the commit it ran on, and
   the person watching sees the same rows you do.
2. **`checks_list` first if you only want to know.** It reads files: what this project checks, and
   how each one stands at the commit that is checked out. No run, no network, no waiting.
3. **A check that never ran is not a check that passed.** The rollup says `unknown` when a required
   check has not run at this commit, and Tade treats that as unverified — not as green.
4. **Run them, then commit — the run follows the work.** A run is about the bytes it read, so the
   commit you make right after a green run still reads green: the record says what was on disk and
   Tade matches it against what the commit holds. What breaks that is committing something else
   with it — a partial commit, or another agent's file in a shared checkout — because then the
   commit is a tree nobody ran anything over, and it goes back to `unknown`. Commit what you
   checked, or check again.
5. **Read the failing tail before changing anything** (`checks_log <id>`). Fix the cause it names,
   not the first symptom you see. If the failure is in a file you did not touch, say so in your
   message rather than working around it.
6. **Run only what you need while you iterate** (`checks_run` with `only`), and run all of them
   before you finish: a check you skipped is the one CI will run.
7. **If a failure is certainly not yours** — a flake, an outage, somebody else's half-finished work
   in a shared checkout — call `checks_override` with the scope and the reason in your own words,
   then push. It is written down with your name on it, the person is told what you said, and the
   red run stays red. Never use it because a check is slow.
8. **Never edit `.tade/checks.jsonl` or `.tade/checks.lock`.** They are Tade's record of what ran;
   changing them is claiming something ran when it did not.
