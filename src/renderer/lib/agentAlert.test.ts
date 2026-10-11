import { describe, expect, it, vi } from 'vitest'
import { ALERT_COOLDOWN_MS, decideAgentAlert, type AgentAlertInput } from './agentAlert'

// A realistic clock: production passes Date.now(), so a fixture "now" near zero would hide a
// cooldown that treats a missing stamp as "chimed at 0".
const NOW = 1_760_000_000_000

const ON = { soundEffects: true, notifyOnClaudeDone: true, notifyConsentAsked: true }

const input = (over: Partial<AgentAlertInput> = {}): AgentAlertInput => ({
  kind: 'done',
  windowFocused: false,
  activeNode: false,
  prefs: ON,
  now: NOW,
  ...over
})

describe('decideAgentAlert — the unread record', () => {
  it('a node you are watching (focused window + its terminal) is not marked unread', () => {
    const d = decideAgentAlert(input({ windowFocused: true, activeNode: true }))
    expect(d.markUnread).toBe(false)
  })

  it('is marked unread while you are in ANOTHER terminal of a focused window', () => {
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: false })).markUnread).toBe(true)
  })

  it('is marked unread when the window is in the background, even if it was the active terminal', () => {
    expect(decideAgentAlert(input({ windowFocused: false, activeNode: true })).markUnread).toBe(true)
  })

  it('acks a finish the user watched, and only a finish', () => {
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: true })).ackDone).toBe(true)
    expect(
      decideAgentAlert(input({ kind: 'needsYou', windowFocused: true, activeNode: true })).ackDone
    ).toBe(false)
    // Not watched ⇒ it is marked unread instead; the ack comes when the user looks.
    expect(decideAgentAlert(input({ windowFocused: true, activeNode: false })).ackDone).toBe(false)
  })
})

describe('decideAgentAlert — quiet (issue #708) and the handoff fold', () => {
  it('quiet silences the chime and the notification but keeps the unread record', () => {
    const d = decideAgentAlert(input({ quiet: true }))
    expect(d).toEqual({ markUnread: true, ackDone: false, sound: false, notify: false })
  })

  it('quiet keeps the ack of a watched finish', () => {
    const d = decideAgentAlert(input({ quiet: true, windowFocused: true, activeNode: true }))
    expect(d.ackDone).toBe(true)
    expect(d.sound).toBe(false)
  })

  it('a done folded into a handoff ping is silent, and keeps its record', () => {
    const d = decideAgentAlert(input({ handoffFolded: () => true }))
    expect(d).toEqual({ markUnread: true, ackDone: false, sound: false, notify: false })
  })

  it('never asks the fold for a quiet turn — asking consumes it', () => {
    const fold = vi.fn(() => true)
    decideAgentAlert(input({ quiet: true, handoffFolded: fold }))
    expect(fold).not.toHaveBeenCalled()
  })

  it('never asks the fold for a needs-you alert — the fold is about turn ends only', () => {
    const fold = vi.fn(() => true)
    const d = decideAgentAlert(input({ kind: 'needsYou', handoffFolded: fold }))
    expect(fold).not.toHaveBeenCalled()
    expect(d.sound).toBe(true)
    expect(d.notify).toBe(true)
  })
})

describe('decideAgentAlert — chime', () => {
  it('chimes whether or not the window is focused', () => {
    expect(decideAgentAlert(input({ windowFocused: false })).sound).toBe(true)
    expect(decideAgentAlert(input({ windowFocused: true })).sound).toBe(true)
  })

  it('does not chime with sound effects off', () => {
    expect(decideAgentAlert(input({ prefs: { ...ON, soundEffects: false } })).sound).toBe(false)
  })

  it('keeps a per-node cooldown of its own', () => {
    expect(decideAgentAlert(input({ lastSoundAt: NOW - ALERT_COOLDOWN_MS + 1 })).sound).toBe(false)
    expect(decideAgentAlert(input({ lastSoundAt: NOW - ALERT_COOLDOWN_MS })).sound).toBe(true)
  })
})

describe('decideAgentAlert — OS notification', () => {
  it('notifies a background finish with notifications on and consent given', () => {
    expect(decideAgentAlert(input()).notify).toBe(true)
  })

  it('never notifies while the window is focused (default behaviour)', () => {
    expect(decideAgentAlert(input({ windowFocused: true })).notify).toBe(false)
    expect(decideAgentAlert(input({ kind: 'needsYou', windowFocused: true })).notify).toBe(false)
  })

  it('needs both the preference and the consent answer', () => {
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyOnClaudeDone: false } })).notify).toBe(false)
    expect(decideAgentAlert(input({ prefs: { ...ON, notifyConsentAsked: false } })).notify).toBe(false)
  })

  it('keeps a per-node cooldown separate from the chime', () => {
    // The chime cooled down, the notification did not — and the other way round.
    const recentNotify = decideAgentAlert(input({ lastNotifyAt: NOW - 1000, lastSoundAt: NOW - 60_000 }))
    expect(recentNotify).toMatchObject({ notify: false, sound: true })
    const recentSound = decideAgentAlert(input({ lastSoundAt: NOW - 1000, lastNotifyAt: NOW - 60_000 }))
    expect(recentSound).toMatchObject({ notify: true, sound: false })
  })
})
