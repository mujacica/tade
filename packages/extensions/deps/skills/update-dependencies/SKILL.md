---
name: update-dependencies
description: How to finish a dependency update Tade started in your worktree — install, test, read the changelogs of major releases, fix what broke, and commit.
---

# Finishing a dependency update

Tade has already moved the requirements forward in the manifests of this worktree. What they were,
what they are now, and how far each moved is in `.tade/context.md`. Your job is to make the project
work on them.

1. **Install first**, so the lockfile matches the manifests: `pnpm install`, `npm install`,
   `yarn install`, `uv lock`, `poetry lock`, `cargo update --workspace` or `go mod tidy` — whichever
   the project uses. Commit the lockfile with the manifests.
2. **Run the tests** the project runs. If the context names a test command, use that one.
3. **Major releases break things on purpose.** Before changing code for one, read its changelog or
   migration guide — the release notes on its repository, or the package's `CHANGELOG.md` — and fix
   the cause it describes, not the symptom you see.
4. **Do not pin a package back** to make a failure go away unless there is no other way. If you do,
   say which one and why in the commit message.
5. `deps_check` shows what is still behind or vulnerable after your changes. Run it before you finish.
6. Commit when the tests pass, with a message that lists the notable updates.
