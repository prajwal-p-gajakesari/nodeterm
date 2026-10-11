import { describe, expect, it, vi } from 'vitest'
import {
  createBoundWorktree,
  createWorktreeWithAgent,
  type CreateBoundWorktreeDeps,
  type WorktreeAgentSteps,
  type WorktreeAttachTarget
} from './worktreeCreate'
import type { WorktreeCreateValue } from '@shared/worktree'

const VALUE: WorktreeCreateValue = {
  repoPath: '/work/repo',
  mode: 'new',
  branch: 'issue-12-fix',
  baseRef: 'main',
  path: '/work/repo.worktrees/issue-12-fix'
}

function deps(over: Partial<CreateBoundWorktreeDeps> = {}): CreateBoundWorktreeDeps & {
  attach: ReturnType<typeof vi.fn>
  worktreeAdd: ReturnType<typeof vi.fn>
} {
  return {
    worktreeAdd: vi.fn(async () => ({ ok: true, message: 'Worktree ready.' })),
    activeProjectId: () => 'p1',
    attach: vi.fn(() => 'group-1'),
    ...over
  } as never
}

describe('createBoundWorktree', () => {
  it('creates the worktree, then binds a frame to it with createdByApp', async () => {
    const d = deps()
    const target: WorktreeAttachTarget = { groupId: null, at: { x: 1, y: 2 }, title: 'Issue #12' }
    const out = await createBoundWorktree(d, VALUE, { target: () => target, projectId: 'p1' })
    expect(d.worktreeAdd).toHaveBeenCalledWith(VALUE.repoPath, VALUE.path, VALUE.branch, VALUE.baseRef, true)
    expect(d.attach).toHaveBeenCalledWith(target, {
      repoPath: VALUE.repoPath,
      branch: VALUE.branch,
      baseRef: 'main',
      path: VALUE.path,
      createdByApp: true
    })
    expect(out).toMatchObject({ ok: true, groupId: 'group-1' })
  })

  it('checks out an EXISTING branch when the mode says so (isNew false)', async () => {
    const d = deps()
    await createBoundWorktree(d, { ...VALUE, mode: 'existing' }, { target: () => ({ groupId: null }) })
    expect(d.worktreeAdd.mock.calls[0][4]).toBe(false)
  })

  it('asks where the frame goes only AFTER git succeeded', async () => {
    const order: string[] = []
    const d = deps({
      worktreeAdd: vi.fn(async () => {
        order.push('git')
        return { ok: true, message: '' }
      })
    })
    await createBoundWorktree(d, VALUE, {
      target: () => {
        order.push('target')
        return { groupId: null }
      }
    })
    expect(order).toEqual(['git', 'target'])
  })

  it('reports a git failure with git\'s own message and binds nothing', async () => {
    const d = deps({ worktreeAdd: vi.fn(async () => ({ ok: false, message: 'fatal: a branch named x exists' })) })
    const target = vi.fn(() => ({ groupId: null }))
    const out = await createBoundWorktree(d, VALUE, { target })
    expect(out).toEqual({ ok: false, reason: 'git', message: 'fatal: a branch named x exists', rejected: false })
    expect(d.attach).not.toHaveBeenCalled()
    expect(target).not.toHaveBeenCalled()
  })

  it('turns a REJECTED call into a failure instead of throwing out of the caller', async () => {
    const d = deps({ worktreeAdd: vi.fn(async () => Promise.reject(new Error('E_DISCONNECTED'))) })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: null }) })
    expect(out).toEqual({ ok: false, reason: 'git', message: 'E_DISCONNECTED', rejected: true })
    expect(d.attach).not.toHaveBeenCalled()
  })

  it('leaves the worktree unbound when the canvas moved to another project during the await', async () => {
    let active = 'p1'
    const d = deps({
      activeProjectId: () => active,
      worktreeAdd: vi.fn(async () => {
        active = 'p2'
        return { ok: true, message: '' }
      })
    })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: null }), projectId: 'p1' })
    expect(out).toMatchObject({ ok: false, reason: 'project-changed', worktree: { branch: VALUE.branch } })
    expect(d.attach).not.toHaveBeenCalled()
  })

  it('without a projectId (the control verb) it binds whatever is on screen, as it always did', async () => {
    const d = deps({ activeProjectId: () => 'somewhere-else' })
    const out = await createBoundWorktree(d, VALUE, { target: () => ({ groupId: 'g' }) })
    expect(out.ok).toBe(true)
    expect(d.attach).toHaveBeenCalledTimes(1)
  })
})

describe('createWorktreeWithAgent ("New agent in new worktree…")', () => {
  const FRAME: WorktreeAttachTarget = { groupId: null, at: { x: 10, y: 20 }, size: { width: 800, height: 600 } }

  /** A canvas stand-in that records the ORDER of what happened, and which frame each step saw. */
  function canvas(over: { refusal?: string | null; openFails?: boolean } = {}) {
    const log: string[] = []
    const d = deps({
      worktreeAdd: vi.fn(async () => {
        log.push('git')
        return { ok: true, message: '' }
      }),
      attach: vi.fn((target: WorktreeAttachTarget) => {
        log.push(`attach ${target.groupId ?? 'new'}`)
        // The first moment anything else (a render flushed by a zustand write) could run.
        queueMicrotask(() => log.push('next tick'))
        return 'frame-7'
      })
    })
    const agent: WorktreeAgentSteps & {
      refusal: ReturnType<typeof vi.fn>
      open: ReturnType<typeof vi.fn>
      focus: ReturnType<typeof vi.fn>
    } = {
      refusal: vi.fn(() => {
        log.push('refusal?')
        return over.refusal ?? null
      }),
      open: vi.fn((groupId: string) => {
        log.push(`open in ${groupId}`)
        return over.openFails ? null : 'agent-1'
      }),
      focus: vi.fn((nodeId: string) => {
        log.push(`focus ${nodeId}`)
      })
    }
    return { d, agent, log }
  }

  it('creates the worktree, binds a NEW frame, and opens the agent in THAT frame inside the bind', async () => {
    const { d, agent, log } = canvas()
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target: () => FRAME, projectId: 'p1' })
    // The agent opens in the frame `attach` returned, synchronously within the bind — before the
    // next tick, so no render can drop the fresh frame from `nodesRef` first.
    expect(log).toEqual(['refusal?', 'git', 'attach new', 'open in frame-7', 'next tick', 'focus agent-1'])
    expect(d.attach).toHaveBeenCalledWith(FRAME, {
      repoPath: VALUE.repoPath,
      branch: VALUE.branch,
      baseRef: VALUE.baseRef,
      path: VALUE.path,
      createdByApp: true
    })
    expect(agent.open).toHaveBeenCalledTimes(1)
    expect(out).toEqual({
      ok: true,
      groupId: 'frame-7',
      worktree: { repoPath: VALUE.repoPath, branch: VALUE.branch, baseRef: 'main', path: VALUE.path, createdByApp: true },
      nodeId: 'agent-1'
    })
  })

  it('refuses BEFORE git when the agent could not be opened — nothing is created', async () => {
    const { d, agent, log } = canvas({ refusal: 'That Codex account is no longer available.' })
    const target = vi.fn(() => FRAME)
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target, projectId: 'p1' })
    expect(out).toEqual({ ok: false, reason: 'agent-refused', message: 'That Codex account is no longer available.' })
    expect(log).toEqual(['refusal?'])
    expect(d.worktreeAdd).not.toHaveBeenCalled()
    expect(target).not.toHaveBeenCalled()
    expect(d.attach).not.toHaveBeenCalled()
    expect(agent.open).not.toHaveBeenCalled()
  })

  it('a git failure leaves no frame and no node, with git\'s own message', async () => {
    const { d, agent } = canvas()
    d.worktreeAdd.mockImplementation(async () => ({ ok: false, message: "fatal: 'x' is already checked out" }))
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target: () => FRAME, projectId: 'p1' })
    expect(out).toEqual({ ok: false, reason: 'git', message: "fatal: 'x' is already checked out", rejected: false })
    expect(d.attach).not.toHaveBeenCalled()
    expect(agent.open).not.toHaveBeenCalled()
    expect(agent.focus).not.toHaveBeenCalled()
  })

  it('a REJECTED git call (dropped socket) is a failure too, never a throw — and opens nothing', async () => {
    const { d, agent } = canvas()
    d.worktreeAdd.mockImplementation(async () => Promise.reject(new Error('E_DISCONNECTED')))
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target: () => FRAME, projectId: 'p1' })
    expect(out).toEqual({ ok: false, reason: 'git', message: 'E_DISCONNECTED', rejected: true })
    expect(d.attach).not.toHaveBeenCalled()
    expect(agent.open).not.toHaveBeenCalled()
  })

  it('binds nothing and opens nothing when the canvas moved to another project during git', async () => {
    let active = 'p1'
    const { d, agent } = canvas()
    d.activeProjectId = () => active
    d.worktreeAdd.mockImplementation(async () => {
      active = 'p2'
      return { ok: true, message: '' }
    })
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target: () => FRAME, projectId: 'p1' })
    expect(out).toMatchObject({ ok: false, reason: 'project-changed', worktree: { branch: VALUE.branch } })
    expect(d.attach).not.toHaveBeenCalled()
    expect(agent.open).not.toHaveBeenCalled()
  })

  it('an agent refused AFTER the bind keeps the bound frame, reports no node and focuses nothing', async () => {
    const { d, agent } = canvas({ openFails: true })
    const out = await createWorktreeWithAgent(d, agent, VALUE, { target: () => FRAME, projectId: 'p1' })
    expect(out).toMatchObject({ ok: true, groupId: 'frame-7', nodeId: null })
    expect(d.attach).toHaveBeenCalledTimes(1)
    expect(agent.focus).not.toHaveBeenCalled()
  })
})
