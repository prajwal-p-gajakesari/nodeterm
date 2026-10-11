import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'

/**
 * agent-sessions is served by BOTH shells, and nothing type-checks that: a shell that forgets
 * `registerAgentSessionsIpc()` compiles, and its renderer's share row stays "Checking…" forever (the
 * bridge answers `{ok:false}`). Pinned at source level, like "Open recent".
 */
const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('agent-sessions wiring', () => {
  it('both shells register the core handlers', () => {
    expect(read('main/index.ts')).toMatch(/^\s+registerAgentSessionsIpc\(\)$/m)
    expect(read('server/index.ts')).toMatch(/^\s+registerAgentSessionsIpc\(\)$/m)
  })

  it('the preload and the browser bridge both reach both channels', () => {
    const preload = read('preload/index.ts')
    expect(preload).toContain('ipcRenderer.invoke(IPC.agentSessionsDetect')
    expect(preload).toContain('ipcRenderer.invoke(IPC.agentSessionsListShared')
    const bridge = read('renderer/bridge/ws-bridge.ts')
    expect(bridge).toContain('client.request(IPC.agentSessionsDetect')
    expect(bridge).toContain('client.request(IPC.agentSessionsListShared')
    expect(bridge).toContain('...buildAgentSessionsApi(client)')
  })

  it('a relay peer may never ask the host for either (the relay tab’s own stub: bridge/relay-api.test.ts)', () => {
    expect(isHostOnlyChannel(IPC.agentSessionsDetect)).toBe(true)
    expect(isHostOnlyChannel(IPC.agentSessionsListShared)).toBe(true)
  })
})
