/**
 * What the number on nodeterm's Dock icon counts (`settings.dockBadgeMode`).
 *
 * - `'unread'` (the default, and the only behaviour before the setting existed): nodes with the
 *   unread flag — something finished or asked for you while you were not watching it. Looking at a
 *   node clears it, even if that node is still blocked.
 * - `'needs-you'`: nodes waiting on the user RIGHT NOW — live state `waiting` (a question) or
 *   `blocked` (an approval), exactly what the node header's NEEDS YOU badge shows, independent of
 *   unread. A finished turn does NOT count, seen or not: it is not blocked on you, and counting it
 *   is what `'unread'` is for. (The sessions sidebar's "Waiting for your response" group does
 *   include `done`; it groups sessions by whose move it is, while this badge answers "how many
 *   agents are stuck until I act".) Live `state` is not persisted, so after a restart this reads 0
 *   until each agent's next hook event says otherwise — a record of the past is never live state.
 * - `'off'`: no badge.
 *
 * Desktop main applies it on macOS only (`app.dock.setBadge`); the Server Edition's bridge has no
 * Dock and drops it.
 */

export const DOCK_BADGE_MODES = ['unread', 'needs-you', 'off'] as const
export type DockBadgeMode = (typeof DOCK_BADGE_MODES)[number]

/** settings.json is hand-editable: an unrecognised mode is the default, never "off" or another
 *  mode by accident. Used on load (core `mergeSettings`) and again at the point of use. */
export function dockBadgeModeOf(value: unknown): DockBadgeMode {
  return (DOCK_BADGE_MODES as readonly unknown[]).includes(value) ? (value as DockBadgeMode) : 'unread'
}

/** One `agentStatus.byId` entry, narrowed to what the count reads. */
export interface DockBadgeEntry {
  state?: string
  unread?: boolean
}

/**
 * The badge number for a status table. A primitive on purpose: Canvas subscribes to THIS, not to
 * the `byId` map, which changes on every hook event of every node.
 */
export function dockBadgeCount(
  byId: Readonly<Record<string, DockBadgeEntry | undefined>>,
  mode: unknown
): number {
  const m = dockBadgeModeOf(mode)
  if (m === 'off') return 0
  let count = 0
  for (const st of Object.values(byId)) {
    if (!st) continue
    if (m === 'unread' ? st.unread : st.state === 'waiting' || st.state === 'blocked') count++
  }
  return count
}
