---
name: fix-sentry-issue
description: How to fix an error Sentry reported — read the context Wilco left, reproduce it from the stack trace and breadcrumbs, fix the cause, prove it with a test, and commit so Sentry resolves it on release.
---

# Fixing a Sentry issue

When Wilco starts you on a Sentry issue, `.wilco/context.md` holds what Sentry knows: the issue's
short id and link, how often it happens and to how many people, the exception, the frame in the
project's own code that matters most (with the lines around it), the stack trace, the breadcrumbs
that led up to it, the request, the release and environment, and the trace id.

1. **Read the context first.** The most relevant frame is where to start reading code, not
   necessarily where the bug is: follow the values back to where they went wrong.
2. **Use the breadcrumbs and the request** to work out the input that causes it. If you need more,
   `sentry_trace <trace id>` shows the whole request across services, and
   `sentry_events dataset=logs query="trace:<trace id>"` shows what was logged during it.
   `sentry_issue` with the short id fetches the issue again, with its latest event.
3. **Reproduce it in a test** before fixing it: a test that fails the way production did is the
   proof the fix is real.
4. **Fix the cause.** A `?.` or a `try` that makes the error disappear without explaining why the
   value was missing is not a fix; say in the commit why it happened.
5. **Commit with `Fixes <SHORT-ID>`** in the message (for example `Fixes SHOP-1A`), so Sentry marks
   the issue resolved when the release containing it is deployed.
6. If Seer has looked at the issue, `sentry_root_cause` says what it found. Treat it as a lead to
   check, not an answer.
