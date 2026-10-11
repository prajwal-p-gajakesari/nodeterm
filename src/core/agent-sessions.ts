// agent-sessions integration, core half (both shells): DETECT whether the optional agent-sessions
// tool is installed for a node's agent + account, and LIST the sessions teammates shared in a
// repository's working tree. Nothing here runs agent-sessions, writes anywhere, or reads a summary
// or transcript: the agent and the tool do all of that, inside the session, after the user says yes.
// The shared leaf (`@shared/agent-sessions`) owns the commands, the folder allowlist and the prompt.
//
// Rules this module keeps, each for a reason:
//  - DETECTION reads only the user's OWN config: the node account's Claude config dir (managed and
//    linked accounts REPLACE `~/.claude`, so the system dir is never consulted for them — a bad id
//    resolves to no dir and reads `unknown`, never the system dir in its place), and the skills dirs
//    the agent reads (`~/.agents/skills`, plus the agent's own). Never the repository's vendored
//    `.agents/skills` or its `.claude/settings.json`: a cloned repo could plant a skill there, and the
//    menu row would then invoke it. For claude only KEY NAMES are read: `installed_plugins.json`'s
//    `plugins` object holding `sessions@agent-sessions`, and `enabledPlugins` naming it `false`.
//  - THREE-VALUED. A file that is not there is `absent`; one that is there but cannot be read or
//    parsed is `unknown` (a failed read is never evidence of absence), and the row stays disabled.
//  - The shared-sessions LISTING treats the repository as HOSTILE (anyone with push access wrote
//    it): `.claude/sessions` must resolve inside the repository, a folder must be a real directory
//    (lstat — a symlink is skipped) whose name passes the strict allowlist, `meta.json` must be a
//    regular file opened without following a link, size-capped, and every field becomes one display
//    line through `untrustedLine`. Bounded: directory entries scanned, folders read, bytes per file
//    and bytes in total are all capped. Read on demand only (a palette open), never on a timer.
import fs, { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import {
  AGENT_SESSIONS_AGENTS,
  AGENT_SESSIONS_CLAUDE_PLUGIN,
  AGENT_SESSIONS_SKILL,
  SHARED_SESSION_AUTHOR_MAX,
  SHARED_SESSION_META_MAX_BYTES,
  SHARED_SESSION_TITLE_MAX,
  SHARED_SESSIONS_MAX,
  SHARED_SESSIONS_SCAN_MAX,
  SHARED_SESSIONS_TOTAL_MAX_BYTES,
  isSafeSharedSessionDir,
  sharedSessionAgent,
  sharedSessionDirDate,
  type AgentSessionsAgent,
  type AgentSessionsDetectRequest,
  type AgentSessionsDetectResult,
  type AgentSessionsPresence,
  type SharedSession,
  type SharedSessionsResult
} from '../shared/agent-sessions'
import { platform } from './platform'
import { claudeSystemConfigDir } from './agents/hooks/claude'
import { claudeConfigDirFor } from './claude-config-dir'
import { isSafeAccountId } from './claude-accounts-core'
import { codexHomeForAccount } from './codex-accounts-core'
import { skillRootsFor } from './agent-integrations'
import { untrustedLine } from './github/control-read'
import { mapLimit } from './recent-conversations'

// ── Detection ─────────────────────────────────────────────────────────────────────────────────

/** Where one node's agent keeps what agent-sessions installs. Injected so a test never resolves the
 *  real home; `defaultAgentSessionsRoots` is the production answer, built from the resolvers the
 *  rest of core already uses. A resolver answers `null` when the account has no resolvable dir. */
export interface AgentSessionsRoots {
  /** The user's home: `~/.agents/skills` lives under it (codex, gemini and opencode read it). */
  home: string
  claudeConfigDir(accountId: string | undefined): string | null
  codexHome(accountId: string | undefined): string | null
  /** gemini's / opencode's own skills dir (`skillRootsFor`, the measured table). */
  ownSkillsDir(agent: 'gemini' | 'opencode'): string
}

export function defaultAgentSessionsRoots(): AgentSessionsRoots {
  return {
    home: os.homedir(),
    claudeConfigDir: (accountId) => {
      if (!accountId) return claudeSystemConfigDir()
      // Same gate as the chat catalog: a bad id is NO account dir — never the system dir in its place.
      if (!isSafeAccountId(accountId)) return null
      try {
        return claudeConfigDirFor(accountId)
      } catch {
        return null
      }
    },
    codexHome: (accountId) => {
      try {
        return codexHomeForAccount(platform().userDataDir, accountId)
      } catch {
        return null // an id outside the alphabet
      }
    },
    ownSkillsDir: (agent) => skillRootsFor(agent, DEFAULT_SETTINGS, platform().userDataDir)[0]
  }
}

/** A user config file is far smaller than this; a larger one is not read (and reads `unknown`). */
export const CONFIG_FILE_MAX_BYTES = 1024 * 1024

type JsonRead = { kind: 'ok'; value: unknown } | { kind: 'absent' } | { kind: 'unreadable' }

/** Parsed config files by (path, mtime, size): a menu open costs a stat per file, not a parse. */
const jsonCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>()
const JSON_CACHE_MAX = 64

export function resetAgentSessionsCacheForTests(): void {
  jsonCache.clear()
}

/** One of the user's own config files. Followed if it is a link (dotfile setups link these). */
async function readUserJson(file: string): Promise<JsonRead> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  if (!st.isFile() || st.size > CONFIG_FILE_MAX_BYTES) return { kind: 'unreadable' }
  const hit = jsonCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { kind: 'ok', value: hit.value }
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    if (jsonCache.size >= JSON_CACHE_MAX) jsonCache.delete(jsonCache.keys().next().value as string)
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
    return { kind: 'ok', value }
  } catch {
    return { kind: 'unreadable' }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `installed_plugins.json` keys its `plugins` object by `name@marketplace` (both the v1 and v2
 *  shapes); only that KEY is read, never an entry's paths or versions. */
export function pluginInstalled(installed: unknown): boolean {
  return isRecord(installed) && isRecord(installed.plugins) && Object.hasOwn(installed.plugins, AGENT_SESSIONS_CLAUDE_PLUGIN)
}

/** `settings.json` switches a plugin off with an explicit `false` under `enabledPlugins`. Anything
 *  else (absent, `true`, a list form) leaves an installed plugin on. */
export function pluginSwitchedOff(settings: unknown): boolean {
  return (
    isRecord(settings) &&
    isRecord(settings.enabledPlugins) &&
    settings.enabledPlugins[AGENT_SESSIONS_CLAUDE_PLUGIN] === false
  )
}

async function detectClaudePlugin(accountId: string | undefined, roots: AgentSessionsRoots): Promise<AgentSessionsPresence> {
  const dir = roots.claudeConfigDir(accountId)
  if (!dir) return 'unknown'
  const installed = await readUserJson(path.join(dir, 'plugins', 'installed_plugins.json'))
  if (installed.kind === 'absent') return 'absent'
  if (installed.kind === 'unreadable') return 'unknown'
  if (!pluginInstalled(installed.value)) return 'absent'
  const settings = await readUserJson(path.join(dir, 'settings.json'))
  // An unreadable settings.json cannot say "off"; the installed plugin is the positive finding.
  return settings.kind === 'ok' && pluginSwitchedOff(settings.value) ? 'disabled' : 'present'
}

/** The SKILL.md paths an agent would load agent-sessions from, in the user's own dirs only. */
export function skillCandidates(
  agent: Exclude<AgentSessionsAgent, 'claude'>,
  accountId: string | undefined,
  roots: AgentSessionsRoots
): string[] {
  const dirs = [path.join(roots.home, '.agents', 'skills')]
  if (agent === 'codex') {
    const home = roots.codexHome(accountId)
    if (home) dirs.push(path.join(home, 'skills'))
  } else {
    dirs.push(roots.ownSkillsDir(agent))
  }
  return [...new Set(dirs)].map((d) => path.join(d, AGENT_SESSIONS_SKILL, 'SKILL.md'))
}

async function fileState(file: string): Promise<'present' | 'absent' | 'unknown'> {
  try {
    // Followed: `npx skills add` installs into `~/.agents/skills` and LINKS it into agent dirs.
    return (await fs.promises.stat(file)).isFile() ? 'present' : 'absent'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

export async function detectAgentSessions(
  req: AgentSessionsDetectRequest,
  roots: AgentSessionsRoots = defaultAgentSessionsRoots()
): Promise<AgentSessionsPresence> {
  if (req.agent === 'claude') return detectClaudePlugin(req.accountId, roots)
  let unknown = false
  for (const file of skillCandidates(req.agent, req.accountId, roots)) {
    const state = await fileState(file)
    if (state === 'present') return 'present'
    if (state === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'absent'
}

/** Sanitize a detect request that arrived over IPC / the WS bridge. */
export function normalizeDetectRequest(raw: unknown): AgentSessionsDetectRequest | null {
  if (!isRecord(raw)) return null
  const agent = raw.agent
  if (typeof agent !== 'string' || !(AGENT_SESSIONS_AGENTS as readonly string[]).includes(agent)) return null
  const accountId = typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : undefined
  return { agent: agent as AgentSessionsAgent, ...(accountId ? { accountId } : {}) }
}

// ── Shared sessions in a repository ───────────────────────────────────────────────────────────

/** `pushed_at` / `started` as agent-sessions writes them (ISO 8601). Anything else is ignored. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+\-Z]{0,40})?$/

// Absent on Windows; there the name is lstat'ed first and compared with the handle we read.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

async function isRegular(file: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).isFile()
  } catch {
    return false
  }
}

/** What one listing may still read. `exhausted` = a file was skipped because the budget ran out. */
interface ReadBudget {
  left: number
  exhausted: boolean
}

/**
 * A committed `meta.json`, or null. The name must be a plain regular file (lstat), the open refuses
 * a link swapped in since (O_NOFOLLOW) and a FIFO cannot hang it (O_NONBLOCK), and the handle we
 * read must be the file we lstat'ed (same dev + ino where the filesystem reports one). Never more
 * than `SHARED_SESSION_META_MAX_BYTES` and never past the listing's remaining byte budget.
 */
async function readMeta(file: string, budget: ReadBudget): Promise<Record<string, unknown> | null> {
  let named: fs.BigIntStats
  try {
    named = await fs.promises.lstat(file, { bigint: true })
  } catch {
    return null
  }
  if (!named.isFile() || named.size > BigInt(SHARED_SESSION_META_MAX_BYTES)) return null
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const st = await fh.stat({ bigint: true })
    if (!st.isFile() || (st.ino !== 0n && (st.ino !== named.ino || st.dev !== named.dev))) return null
    const size = Number(st.size)
    if (size > SHARED_SESSION_META_MAX_BYTES) return null
    if (size > budget.left) {
      budget.exhausted = true
      return null
    }
    budget.left -= size
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, 0)
    const value: unknown = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

const isoOf = (v: unknown): string | undefined => (typeof v === 'string' && ISO_DATE_RE.test(v) ? v : undefined)

/** One listed session from a validated folder name and its parsed `meta.json`. Pure. */
export function sharedSessionFromMeta(
  dir: string,
  meta: Record<string, unknown>,
  files: { hasSummary: boolean; hasTranscript: boolean }
): SharedSession & { sortKey: string } {
  const agent = sharedSessionAgent(meta.agent)
  const started = isoOf(meta.started)
  const pushed = isoOf(meta.pushed_at)
  const author = untrustedLine(meta.author, SHARED_SESSION_AUTHOR_MAX) || untrustedLine(meta.handle, SHARED_SESSION_AUTHOR_MAX)
  return {
    dir,
    title: untrustedLine(meta.title, SHARED_SESSION_TITLE_MAX),
    author,
    ...(agent ? { agentId: agent.id } : {}),
    agentLabel: agent?.label ?? '',
    date: (started ?? pushed ?? sharedSessionDirDate(dir)).slice(0, 10),
    hasSummary: files.hasSummary,
    hasTranscript: files.hasTranscript,
    sortKey: pushed ?? started ?? sharedSessionDirDate(dir)
  }
}

/** Is `child` strictly below `parent`? Both are real paths of ONE machine, compared in that
 *  machine's dialect (`p` is injectable so the Windows shape is tested on any host); a sibling that
 *  merely shares the prefix (`/repo-evil` beside `/repo`) is outside. */
export function isStrictlyInside(child: string, parent: string, p: typeof path = path): boolean {
  const rel = p.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel)
}

/** Folders read at once. */
const READ_CONCURRENCY = 16

export async function listSharedSessions(repoRoot: unknown): Promise<SharedSessionsResult> {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) return { ok: false, reason: 'bad-request' }
  const dir = path.join(repoRoot, '.claude', 'sessions')
  let realDir: string
  let realRoot: string
  try {
    realRoot = await fs.promises.realpath(repoRoot)
    realDir = await fs.promises.realpath(dir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // Nothing has been shared (or pulled) here yet: a definite, empty answer.
    return code === 'ENOENT' || code === 'ENOTDIR' ? { ok: true, items: [], truncated: false } : { ok: false, reason: 'failed' }
  }
  // `.claude` or `.claude/sessions` linked out of the repository lists nothing: it is not this
  // repository's shared sessions, and following it would read wherever the link points.
  if (!isStrictlyInside(realDir, realRoot)) return { ok: false, reason: 'refused' }
  const names: string[] = []
  let scanned = 0
  let truncated = false
  try {
    const handle = await fs.promises.opendir(dir)
    for await (const entry of handle) {
      if (++scanned > SHARED_SESSIONS_SCAN_MAX) {
        truncated = true
        break // leaving the loop closes the handle
      }
      if (isSafeSharedSessionDir(entry.name)) names.push(entry.name)
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  // Folder names start with the session's date, so name order is date order: slice BEFORE any read.
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  if (names.length > SHARED_SESSIONS_MAX) truncated = true
  const budget: ReadBudget = { left: SHARED_SESSIONS_TOTAL_MAX_BYTES, exhausted: false }
  const read = await mapLimit(names.slice(0, SHARED_SESSIONS_MAX), READ_CONCURRENCY, async (name) => {
    const folder = path.join(dir, name)
    try {
      // A real directory, never a link to one elsewhere.
      if (!(await fs.promises.lstat(folder)).isDirectory()) return null
    } catch {
      return null
    }
    const meta = await readMeta(path.join(folder, 'meta.json'), budget)
    if (!meta) return null
    const [hasSummary, single, firstPart] = await Promise.all([
      isRegular(path.join(folder, 'summary.md')),
      isRegular(path.join(folder, 'transcript.md')),
      isRegular(path.join(folder, 'transcript-1.md'))
    ])
    return sharedSessionFromMeta(name, meta, { hasSummary, hasTranscript: single || firstPart })
  })
  if (budget.exhausted) truncated = true
  const items = read
    .filter((x): x is SharedSession & { sortKey: string } => x !== null)
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0))
    .map(({ sortKey: _sortKey, ...rest }) => rest)
  return { ok: true, items, truncated }
}

// ── Registration (both shells) ────────────────────────────────────────────────────────────────

/** `agent-sessions:detect` and `agent-sessions:list-shared`, registered by BOTH shells (each answers
 *  for the machine its sessions run on). Host-only on the relay (`HOST_ONLY_CHANNELS`). */
export function registerAgentSessionsIpc(roots: () => AgentSessionsRoots = defaultAgentSessionsRoots): void {
  platform().handle(IPC.agentSessionsDetect, async (raw: unknown): Promise<AgentSessionsDetectResult> => {
    const req = normalizeDetectRequest(raw)
    if (!req) return { ok: false, reason: 'bad-request' }
    try {
      return { ok: true, presence: await detectAgentSessions(req, roots()) }
    } catch {
      return { ok: false, reason: 'failed' }
    }
  })
  platform().handle(IPC.agentSessionsListShared, async (raw: unknown): Promise<SharedSessionsResult> => {
    try {
      return await listSharedSessions(isRecord(raw) ? raw.repoRoot : undefined)
    } catch {
      return { ok: false, reason: 'failed' }
    }
  })
}
