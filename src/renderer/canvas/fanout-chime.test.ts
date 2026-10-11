// The completion alert must go QUIET while the parent still holds working subagent cards, and the
// unread record must stay on the other side of that gate (issue #708).
//
// Canvas.tsx is a ~12k-line monolith and this listener lives inside one of its `useEffect`s — there
// is no harness that can dispatch an `agent:status` event at it (see the note at the top of
// `agent-status-rescue.test.ts`, which pins its sibling invariant the same way). The DECISIONS are
// pure and behaviourally tested — "still working?" in `renderer/lib/completionAlert.test.ts`, and
// what a quiet alert silences (the interrupts, never the unread record) in
// `renderer/lib/agentAlert.test.ts`; what only the source can show is that Canvas asks them, for
// the right event, and applies the answer.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the `alert` closure in the agent-status listener. */
function alertBody(): string {
  const start = src.indexOf('const alert = (')
  expect(start, 'Canvas must still build its alert closure').toBeGreaterThan(-1)
  const end = src.indexOf('const an = useAgentNodes.getState()', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Canvas completion alert — background fan-out (issue #708)', () => {
  it('asks the shared predicate rather than re-deriving "still working" inline', () => {
    expect(src).toContain("import { fanoutStillWorking } from '@renderer/lib/completionAlert'")
    // The verdict must be computed from the LIVE store, not from the `an` snapshot taken at
    // listener entry, and it must be handed to the alert as `quiet`.
    expect(src).toMatch(
      /fanoutStillWorking\(\s*Object\.values\(useAgentNodes\.getState\(\)\.byId\),\s*e\.nodeId\s*\)/
    )
  })

  it('gates only the completion alert, never "needs input"', () => {
    // A blocked/waiting agent needs the user NOW, whatever its subagents are doing.
    const done = src.match(/alert\('finished',[^\n]*\)/)
    expect(done, "the 'finished' alert call must still exist").toBeTruthy()
    expect(done![0]).toContain('quiet:')
    for (const m of src.matchAll(/alert\('needs input',[^\n]*\)/g)) {
      expect(m[0]).not.toContain('quiet')
    }
  })

  it('hands the quiet verdict to the shared decision, which keeps the unread record', () => {
    // The ORDER that used to be pinned here (unread + ack above the quiet return, both interrupts
    // below it) is now `decideAgentAlert`'s, and is behaviour-tested in lib/agentAlert.test.ts
    // ("quiet silences the chime and the notification but keeps the unread record"). What only
    // the source can show is that the closure asks it, with the quiet flag, and applies the
    // record half from its answer rather than from a gate of its own.
    const body = alertBody()
    expect(body).toMatch(/decideAgentAlert\(\{/)
    expect(body).toMatch(/quiet: opts\?\.quiet,/)
    expect(body).toMatch(/if \(d\.markUnread\) cs\.markUnread\(e\.nodeId\)/)
    expect(body).toMatch(/if \(d\.ackDone\) void window\.nodeTerminal\.ackDone\(e\.nodeId\)/)
    // No interrupt may bypass the decision.
    expect(body).toMatch(/if \(d\.sound\) \{/)
    expect(body).toMatch(/if \(d\.notify\) \{/)
  })
})
