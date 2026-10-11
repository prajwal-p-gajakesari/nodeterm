// Canvas wires the agent-sessions integration's two actions, and Canvas cannot be mounted in a test,
// so the wiring is pinned at source level here; every rule it relies on is behaviour-tested where it
// lives (lib/agentSessionsShare.test.ts, @shared/agent-sessions.test.ts, state/agentSessions.test.ts).
// What only this file can see: that the share click goes through the gated chain on the PROJECT's own
// session, and that nothing a teammate wrote reaches the continue prompt.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** The source of one `const name = useCallback(…)` up to the next top-level `const` in the body. */
function callback(name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`)
  expect(at, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n  const ', at + 10)
  return src.slice(at, end === -1 ? undefined : end)
}

describe('Canvas — Share session to repo', () => {
  it('types only through the share chain, on the node’s own project session', () => {
    const body = callback('shareSessionToRepo')
    expect(body).toContain('const target = sessionForProject(projectId)')
    expect(body).toContain('await sendShareCommand(nodeId, agentId, label, {')
    expect(body).toContain('chatPaneRefusal(agentId, nodeId, { paneOwner: (id) => target.api.pty.paneOwner(id), customAgents })')
    expect(body).toContain('target.api.pty.sendChatPrompt(nodeId, text, agentId)')
    // Never a bare write that skips the screen check, and never the active tab's api.
    expect(body).not.toMatch(/\.sendText\(|(?<![.\w])api\.pty\./)
  })
})

describe('Canvas — Continue shared session', () => {
  it('composes the first prompt only from the validated folder name, spilled like every launch prompt', () => {
    const body = callback('continueSharedSession')
    expect(body).toContain('async (dir: string): Promise<void> =>')
    expect(body).toContain('const prompt = sharedSessionContinuePrompt(dir)')
    expect(body).toContain('await launchPromptFor(')
    expect(body).toContain('addAgentNode(')
    // Nothing from meta.json or the session's files is read or typed here.
    expect(body).not.toMatch(/\.title\b|\.author\b|summary\.md|transcript/)
  })

  it('a palette row hands over the folder name and nothing else', () => {
    expect(src).toContain('run: () => void continueSharedSession(shared.dir)')
    expect(src.match(/continueSharedSession\(/g)?.length).toBe(1)
  })
})
