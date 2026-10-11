---
name: update-dependencies
description: How to finish a dependency update Tade started in your worktree — install, run the project's own checks, read the changelogs of major releases, fix what broke, and commit only what is green.
---

# Finishing a dependency update

Tade has already moved the requirements forward in the manifests of this worktree, or has told you
which packages to move with `deps_update`. What they were, what they are now, and how far each moved
is in your task's context file. Your job is to make the project work on them — and to leave it alone if it
cannot.

1. **Install first**, so the lockfile matches the manifests: `pnpm install`, `npm install`,
   `yarn install`, `uv lock`, `poetry lock`, `cargo update --workspace` or `go mod tidy` — whichever
   the project uses. Commit the lockfile with the manifests.
2. **Run the project's own checks with `checks_run`**, never by typing the command in a shell. Tade
   runs one suite per checkout, waits for anybody else's rather than starting a second beside it,
   and records what ran against the tree it ran on. If Tade has no checks for this project, run the
   test command the context names, and say so if there is none.
3. **Major releases break things on purpose.** Before changing code for one, read its changelog or
   migration guide — the release notes on its repository, or the package's `CHANGELOG.md` — and fix
   the cause it describes, not the symptom you see. A watch never bumps a major: if one is named in
   your context as waiting, leave it exactly as written and say so at the end.
4. **Do not pin a package back** to make a failure go away unless there is no other way. If you do,
   say which one and why in the commit message.
5. **One bad release must not hold up the others.** Where several packages moved together and one of
   them is what the checks are failing on, put that one back to the version it was, keep the rest,
   and say which you left behind and what it broke.
6. **In a project's own checkout, commit the manifests and lockfiles you moved and nothing else**,
   each added by its path — never `git add -A`, `git add .` or `git commit -a`. A bump normally gets
   a worktree of its own, where everything in the tree is yours; where your task's prompt says you
   are in the project's own checkout, every other change in it is somebody else's, and uncommitted
   work that was there before you is theirs to finish: leave it exactly as it is and say so.
7. **Commit only what is green, and never a red tree.** If you cannot make the checks pass, put
   every manifest and lockfile back the way you found it, commit nothing, and say what broke and how
   far you got. A dependency update that lands broken code is worse than no update at all.
8. `deps_check` shows what is still behind or vulnerable after your changes. Run it before you
   finish.
