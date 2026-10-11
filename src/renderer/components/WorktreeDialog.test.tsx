// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogStack } from './dialog-stack'
import { WorktreeDialog, type WorktreeAgentOption } from './WorktreeDialog'
import type { WorktreeEntry } from '@shared/worktree'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const existing: WorktreeEntry[] = [
  { path: '/repo.wt/feature-login', branch: 'feature/login', head: 'a', isBare: false },
  { path: '/repo.wt/fix-api', branch: 'fix/api', head: 'b', isBare: false }
]

describe('WorktreeDialog existing-worktree search', () => {
  let root: Root | undefined
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
    resetDialogStack()
  })

  it('filters the scrollable picker by branch or path', () => {
    root = createRoot(host)
    act(() => {
      root!.render(
        <WorktreeDialog
          intent="create"
          repoPath="/repo"
          existing={existing}
          defaultBaseRef="main"
          branches={[]}
          defaultPath={() => '/repo.wt/feature'}
          busy={false}
          error={null}
          onCreate={vi.fn()}
          onBindExisting={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    const search = document.querySelector<HTMLInputElement>(
      '[aria-label="Search existing worktrees"]'
    )!
    expect(document.querySelectorAll('.bind-existing__row')).toHaveLength(2)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'LOGIN')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const rows = [...document.querySelectorAll('.bind-existing__row')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('feature/login')
  })
})

describe('WorktreeDialog with an agent ("New agent in new worktree…")', () => {
  let root: Root | undefined
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
    resetDialogStack()
  })

  const AGENTS: WorktreeAgentOption[] = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'custom:abc', label: 'My Agent' }
  ]

  function render(props: {
    intent: 'create' | 'bind' | 'agent'
    agents?: { options: WorktreeAgentOption[]; defaultId: string }
    onCreate?: (...args: unknown[]) => void
  }): void {
    root = createRoot(host)
    act(() => {
      root!.render(
        <WorktreeDialog
          intent={props.intent}
          agents={props.agents}
          repoPath="/repo"
          existing={existing}
          defaultBaseRef="main"
          branches={[]}
          defaultPath={() => '/repo.wt/feature'}
          busy={false}
          error={null}
          onCreate={props.onCreate ?? vi.fn()}
          onBindExisting={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })
  }

  const field = (name: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('.bind-field')].find((f) =>
      f.textContent?.trim().startsWith(name)
    )
  const agentShown = (): string | undefined =>
    field('Agent')?.querySelector('.bind-select__val, .bind-select__ph')?.textContent ?? undefined
  const primary = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('.confirm__btn.primary')!

  function typeBranch(value: string): void {
    const input = field('Branch')!.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function pickAgent(label: string): void {
    act(() => field('Agent')!.querySelector<HTMLButtonElement>('.bind-select')!.click())
    const row = [...document.querySelectorAll<HTMLButtonElement>('.bind-select__menu button')].find(
      (b) => b.textContent?.includes(label)
    )!
    act(() => row.click())
  }

  it('preselects the default agent, by its LABEL, and creates with the agent picked', () => {
    const onCreate = vi.fn()
    render({ intent: 'agent', agents: { options: AGENTS, defaultId: 'codex' }, onCreate })
    expect(document.querySelector('.confirm__msg')?.textContent).toBe('New agent in new worktree')
    expect(agentShown()).toBe('Codex')
    pickAgent('My Agent')
    expect(agentShown()).toBe('My Agent')
    typeBranch('feature/login-fix')
    expect(primary().textContent).toBe('Create & start')
    act(() => primary().click())
    expect(onCreate).toHaveBeenCalledWith(
      { repoPath: '/repo', mode: 'new', branch: 'feature/login-fix', baseRef: 'main', path: '/repo.wt/feature' },
      'custom:abc'
    )
  })

  it('falls back to the first agent when the default is not offered (switched off since)', () => {
    render({ intent: 'agent', agents: { options: AGENTS, defaultId: 'gemini' } })
    expect(agentShown()).toBe('Claude Code')
  })

  it('cannot create with no agent to open — and says why', () => {
    render({ intent: 'agent', agents: { options: [], defaultId: 'claude' } })
    typeBranch('feature/x')
    expect(primary().disabled).toBe(true)
    expect(field('Agent')?.textContent).toContain('No agent is enabled')
  })

  it('only creates: the adopt-an-existing-worktree list belongs to "New worktree…"', () => {
    render({ intent: 'agent', agents: { options: AGENTS, defaultId: 'claude' } })
    expect(document.querySelectorAll('.bind-existing__row')).toHaveLength(0)
  })

  it('the plain create and bind dialogs have no agent picker and create without an agent', () => {
    for (const intent of ['create', 'bind'] as const) {
      const onCreate = vi.fn()
      render({ intent, agents: { options: AGENTS, defaultId: 'claude' }, onCreate })
      expect(field('Agent')).toBeUndefined()
      expect(document.querySelectorAll('.bind-existing__row')).toHaveLength(2)
      typeBranch('feature/y')
      act(() => primary().click())
      expect(onCreate).toHaveBeenCalledTimes(1)
      expect(onCreate.mock.calls[0][1]).toBeUndefined()
      act(() => root?.unmount())
      root = undefined
      resetDialogStack()
    }
  })
})
