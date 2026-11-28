// How far below the window what Tade starts gives way: the numbers and the
// sentence, out of `priority.ts` because that file finds `nice` on the PATH
// (`which.ts`, the disk) and these are read where nothing may reach Node —
// the config's schema and the Settings page, which a browser draws too.
// `priority.ts` hands them on, so nothing that imported them there changes.

/**
 * As far as `nice` goes without privilege, and as far as this will ever ask.
 *
 * POSIX nice runs 0 to 19 for lowering, and 19 is "only when nothing else
 * wants the machine" — which is a real answer for a long check suite and the
 * wrong one for an agent you are waiting on. The schema stops at it; what to
 * actually use is the person's, and the research's starting point is 5.
 */
export const GIVE_WAY_MAX = 19

/**
 * What a config that says nothing gives way by. Halfway down, and well clear
 * of 19: with the QoS clamp doing the work on a Mac, the number is mostly
 * Linux's, where 10 below the window weighs 110 to its 1024 on a contended
 * core (CFS) — the window first, and an agent still making progress.
 */
export const GIVE_WAY_DEFAULT = 10

/** What `nice` here means, in the one sentence read wherever somebody is deciding. */
export const GIVE_WAY_MEANS =
  'agents and check runs are started below the window — nice, plus a utility QoS clamp on macOS and best-effort ionice on Linux — so the window and its own git and ps stay quick while the machine is busy; 0 is off, and it applies to the next one started'
