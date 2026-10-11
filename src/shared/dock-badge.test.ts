import { describe, expect, it } from 'vitest'
import { DOCK_BADGE_MODES, dockBadgeCount, dockBadgeModeOf } from './dock-badge'

// Discriminating on purpose: no row is both unread and needs-you, so a mode that counted the
// other mode's rows (or both) gives a different number.
const TABLE = {
  readButBlocked: { state: 'blocked', unread: false }, // looked at, still waiting on an approval
  unseenQuestion: { state: 'waiting', unread: true }, //  needs you AND unread
  finishedUnseen: { state: 'done', unread: true }, //     done while you were away
  working: { state: 'working', unread: false },
  idle: { unread: false },
  gone: undefined
}

describe('dockBadgeCount', () => {
  it("'unread' counts the unread flag — today's badge, unchanged", () => {
    expect(dockBadgeCount(TABLE, 'unread')).toBe(2) // unseenQuestion + finishedUnseen
  })

  it("'needs-you' counts nodes waiting on the user now, whether or not they were looked at", () => {
    expect(dockBadgeCount(TABLE, 'needs-you')).toBe(2) // readButBlocked + unseenQuestion
  })

  it("'needs-you' does not count a finished turn, seen or not", () => {
    expect(dockBadgeCount({ a: { state: 'done', unread: true }, b: { state: 'done' } }, 'needs-you')).toBe(0)
  })

  it("'needs-you' is independent of unread: clearing unread keeps a blocked node counted", () => {
    expect(dockBadgeCount({ a: { state: 'blocked', unread: true } }, 'needs-you')).toBe(1)
    expect(dockBadgeCount({ a: { state: 'blocked', unread: false } }, 'needs-you')).toBe(1)
    expect(dockBadgeCount({ a: { state: 'blocked', unread: false } }, 'unread')).toBe(0)
  })

  it("'off' is 0 — which is what clears the Dock badge", () => {
    expect(dockBadgeCount(TABLE, 'off')).toBe(0)
  })

  it('an unrecognised mode counts like the default', () => {
    expect(dockBadgeCount(TABLE, 'everything')).toBe(dockBadgeCount(TABLE, 'unread'))
    expect(dockBadgeCount(TABLE, undefined)).toBe(dockBadgeCount(TABLE, 'unread'))
  })
})

describe('dockBadgeModeOf', () => {
  it('keeps every known mode', () => {
    for (const m of DOCK_BADGE_MODES) expect(dockBadgeModeOf(m)).toBe(m)
  })

  it('reads anything else as the default, never as off', () => {
    for (const v of ['OFF', 'needs_you', '', 0, null, undefined, true, {}]) expect(dockBadgeModeOf(v)).toBe('unread')
  })
})
