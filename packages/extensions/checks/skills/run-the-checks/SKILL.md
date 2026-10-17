---
name: run-the-checks
description: How to run a project's own checks through Tade before committing or pushing — what the ids mean, how to read a failing tail, and what to do when a failure is not yours.
---

# Running the checks

1. **Ask Tade to run them, not your shell.** `checks_run` takes the worktree's lock and one of the
   machine's turns (`checks.suites`, one unless somebody changed it), so several agents — in one
   checkout or in many worktrees — never start several suites at once, which is what makes a suite
   time out and look like a regression it is not. Pass `wait` and it queues for its turn rather than
   failing as busy. It records what ran against the commit it ran on, and the person watching sees
   the same rows you do. A project may make a full suite typed into a shell wait for the same turn
   (Tade's own does); one test file never waits.
2. **`checks_list` first if you only want to know.** It reads files: what this project checks, and
   how each one stands at the commit that is checked out. No run, no network, no waiting.
   It also says *where each check came from*, because nothing here is configured: they are read out
   of the project's own CI workflows — the steps of a job in a workflow that runs on every change —
   and its own commit hook. There is no `.tade/checks.yaml` and no tool that writes one.
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
6. **Run only what you need while you iterate** (`checks_run` with `only`, or with
   `related: true`), and run all of them before you finish — unless the full run is batched.
7. **Where the full run is batched, the related run is what finishing needs.** What you are told
   says so when it is: `checks_run` with `related: true` runs the commit hook and `related`, the
   tests your change touches, picked from the import graph — pass `paths`, the files you changed,
   so another agent's half-written work is not in it. Then commit and call your work done. The
   full checks run once for every batch of commits, on HEAD, in a tree of their own; a red one
   comes back to the task whose commit broke it. A green related run is never the full checks
   passing: the rollup stays `unknown` and the page says *related tests passed, full run pending*.
   Before a push, the full checks have to be green on the exact tree — `checks_run` without
   `related`.
8. **A check that `does not run here` is not yours to make pass.** It keeps its row and says why in
   a few words, and it is left out of what the local run adds up to. Two reasons, and neither is a
   thing to work around: the reading found that nothing here can run it — a secret, a service
   container, something only the runner knows — or somebody turned it off on this machine, which is
   their decision and not an invitation to turn it back on. Do not read its absence as green either:
   the clause beside the rollup (*on this machine, not CI's matrix*) is the rest of it.
9. **Where a project says nothing at all, Tade will not invent a gate.** `checks_list` says so, and
   then working out what checking that project means is yours: run its tests, its type checker, its
   linter, and say in your last message what you ran and what it said. Nothing recorded a run, so
   your word is the only evidence there is.
10. **If a failure is certainly not yours** — a flake, an outage, somebody else's half-finished work
   in a shared checkout — call `checks_override` with the scope and the reason in your own words,
   then push. It is written down with your name on it, the person is told what you said, and the
   red run stays red. Never use it because a check is slow.
11. **Never edit `checks.jsonl`, `checks.lock` or the machine's slots in Tade's home.** They are its
   record of what ran and who is running; changing them is claiming something ran when it did not,
   or that nobody is running when somebody is.
