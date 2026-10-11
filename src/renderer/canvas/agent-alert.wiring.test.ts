// Wiring pins for the agent alert. The decisions are pure and behaviour-tested in
// `renderer/lib/agentAlert.test.ts`; what only the source can show is that Canvas — whose
// agent-status listener no harness can dispatch at (see fanout-chime.test.ts) — applies them. Each
// of these ships inert with a green suite if its wiring is dropped:
//  - the `force` the opt-in decides: without it main skips every notification raised while its
//    window is focused, which is exactly when "notify while nodeterm is in front" fires;
//  - the consent answer: the needs-you toggle ships ON, so a consent site that writes only the
//    finish toggle leaves a user who declined with needs-you banners;
//  - the Dock badge mode: `dockBadgeCount` (behaviour-tested in shared/dock-badge.test.ts) is only
//    a setting if Canvas counts with the user's mode and sends the result.

import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

const canvas = read('Canvas.tsx')

function alertBody(): string {
  const start = canvas.indexOf('const alert = (')
  const end = canvas.indexOf('const an = useAgentNodes.getState()', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return canvas.slice(start, end)
}

describe('Canvas agent alert wiring', () => {
  it('forwards the decided force to main, and only the decided one', () => {
    const body = alertBody()
    const notify = body.slice(body.indexOf('nodeTerminal.notify('))
    expect(notify).toMatch(/\.\.\.\(d\.force \? \{ force: true \} : \{\}\)/)
    // No unconditional force: a background notification keeps main's focused-window skip.
    expect(notify).not.toMatch(/^\s*force: true/m)
  })

  it('every consent answer goes through notifyConsentPatch', () => {
    for (const rel of ['Canvas.tsx', '../components/onboarding/OnboardingFlow.tsx', '../components/NotifyConsentDialog.tsx']) {
      // A hand-rolled `{ notifyConsentAsked: true, notifyOnClaudeDone: … }` is the bug this exists
      // to stop: it answers one kind and leaves the other at its default.
      expect(read(rel), rel).not.toMatch(/notifyConsentAsked:\s*true/)
    }
    // First launch records "declined" before the dialog opens, the tour's skip does the same,
    // and the dialog's Enable answers yes — all three through the helper.
    expect(canvas).toContain('useSettings.getState().update(notifyConsentPatch(false))')
    expect(canvas).toMatch(/s\.notifyConsentAsked \? \{\} : notifyConsentPatch\(false\)/)
    expect(canvas).toContain('useSettings.getState().update(notifyConsentPatch(true))')
  })
})

describe('Canvas Dock badge wiring', () => {
  it("counts with the user's mode, as a primitive selector, and sends that count", () => {
    expect(canvas).toContain('const dockBadgeMode = useSettings((s) => s.settings.dockBadgeMode)')
    expect(canvas).toContain('useAgentStatus((s) => dockBadgeCount(s.byId, dockBadgeMode))')
    expect(canvas).toMatch(/window\.nodeTerminal\.setBadgeCount\(dockBadge\)\s*\}, \[dockBadge\]\)/)
  })
})
