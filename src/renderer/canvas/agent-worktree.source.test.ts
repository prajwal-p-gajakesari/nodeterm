import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for "New agent in new worktree…" inside Canvas.tsx — the wiring between the
 * dialog, the ⌘K row and the pure create flow. Like `issue-worktree.source.test.ts`, they exist
 * because the call sites live inside a component no unit test mounts; the BEHAVIOUR is proven
 * against real code elsewhere: the create/refuse/bind/open sequence in `lib/worktreeCreate.test.ts`
 * (`createWorktreeWithAgent`), the menu rows and their gates in `lib/addMenuSpec.test.tsx`, the
 * dialog in `components/WorktreeDialog.test.tsx`. What only these pins can say is that Canvas
 * hands that flow the right pieces.
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function code(body: string): string {
  return body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function between(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThan(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return code(src.slice(a, b))
}

/** The dialog's agent branch of `createWorktreeAndGroup`, up to the plain create. */
const agentBranch = (): string => {
  const body = between('const createWorktreeAndGroup = useCallback(', 'const bindExistingWorktree = useCallback(')
  const a = body.indexOf('if (target.withAgent) {')
  expect(a).toBeGreaterThan(-1)
  const b = body.indexOf('createBoundWorktree(worktreeCreateDeps(), v, {', a)
  expect(b).toBeGreaterThan(a)
  return body.slice(a, b)
}

describe('the dialog creates through createWorktreeWithAgent', () => {
  it('only after the shared-location refusal (every create path runs it before git)', () => {
    const body = between('const createWorktreeAndGroup = useCallback(', 'const bindExistingWorktree = useCallback(')
    const refuse = body.indexOf('if (locationRefusal) {\n        setWorktreeError(locationRefusal)\n        return')
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(body.indexOf('createWorktreeWithAgent('))
  })

  it("asks addAgentNode's own refusals before git, and opens the agent into the frame attach returned", () => {
    const branch = agentBranch()
    expect(branch).toContain('createWorktreeWithAgent(\n          worktreeCreateDeps(),')
    expect(branch).toContain('refusal: () => agentCreateRefusal(agentId, undefined),')
    expect(branch).toContain('open: (groupId) => openAgentInFrame(groupId, agentId, undefined)?.node.id ?? null,')
  })

  it('passes the dialog\'s project, so git finishing after a tab switch binds and opens nothing', () => {
    expect(agentBranch()).toContain('projectId: target.projectId')
  })

  it('places a NEW frame, sized for the agent, asked only once git succeeded', () => {
    const branch = agentBranch()
    expect(branch).toMatch(
      /target: \(\) => \{\s*const size = agentFrameSize\(terminalNodeSize\(\), WORKTREE_GROUP_SIZE\)\s*return \{\s*groupId: null,/
    )
  })

  it('reports git failures and refusals inline (dialog open), a project change as a notice', () => {
    const branch = agentBranch()
    expect(branch).toMatch(
      /if \(!res\.ok && res\.reason !== 'project-changed'\) \{\s*setWorktreeError\(\s*res\.reason === 'git' && res\.rejected \? `Could not create the worktree: \$\{res\.message\}` : res\.message\s*\)\s*return\s*\}/
    )
    expect(branch).toContain('The project changed, so no group or agent was started.')
  })

  it('selects the new node, and hands it the keyboard only when no board covers the canvas', () => {
    const branch = agentBranch()
    const focus = branch.slice(branch.indexOf('focus: (nodeId) => {'))
    expect(focus).toMatch(
      /focus: \(nodeId\) => \{\s*setNodes\(\(ns\) => ns\.map\(\(n\) => \(\{ \.\.\.n, selected: n\.id === nodeId \}\)\)\)\s*if \(isGlobalKanbanOpen\(\) \|\| isKanbanOpen\(useProjects\.getState\(\)\.activeProjectId\)\) return\s*useTerminalFocus\.getState\(\)\.request\(nodeId\)\s*\}/
    )
  })
})

describe('the entry points', () => {
  it('openWorktreeDialog refuses the agent variant in a shared tab, before the dialog opens', () => {
    const body = between('const openWorktreeDialog = useCallback(', 'const openAgentInFrame = useCallback(')
    const relay = body.indexOf(
      "if (opts?.withAgent && sessionForProject(projectId).source === 'relay') {\n        setNotice({ kind: 'error', text: WORKTREE_AGENT_RELAY_NOTICE })\n        return\n      }"
    )
    expect(relay).toBeGreaterThan(-1)
    expect(relay).toBeLessThan(body.indexOf('setWorktreeDialog('))
  })

  it('the ⌘K row opens the agent variant and carries the row\'s reasons as its note', () => {
    const row = between("id: 'worktree-new-agent',", '...(useSettings.getState().settings.debugLogPanel')
    expect(row).toContain('label: WORKTREE_AGENT_LABEL,')
    expect(row).toMatch(
      /note: isSshProject\s*\? WORKTREE_SSH_HINT\s*: sessionForProject\(activeProjectId \?\? ''\)\.source === 'relay'\s*\? WORKTREE_AGENT_RELAY_HINT\s*: undefined,/
    )
    expect(row).toContain('run: () => openWorktreeDialog(null, undefined, { withAgent: true })')
  })

  it('the add menus (through addMenuSpec) and the Dock open the agent variant', () => {
    const body = code(src)
    expect(body).toContain('worktreeAgent: (at) => openWorktreeDialog(null, at, { withAgent: true })')
    expect(body).toContain('onAddWorktreeAgent={() => openWorktreeDialog(null, undefined, { withAgent: true })}')
    expect(body).toContain("isRelayTab: sessionForProject(activeProjectId ?? '').source === 'relay'")
  })
})
