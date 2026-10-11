// agent-sessions integration, core half (both shells): DETECT whether the optional agent-sessions
// tool is installed for a node's agent + account, look for a REPOSITORY copy that could run in its
// place, and LIST the sessions teammates shared in a repository's working tree. Nothing here runs
// agent-sessions, writes anywhere, or reads a summary or transcript. What the typed command runs is
// resolved by the AGENT, and the preview + confirmation are enforced by the agent-sessions skill —
// nodeterm cannot enforce either, which is what the repository-copy refusal is for.
// The shared leaf (`@shared/agent-sessions`) owns the commands, the folder allowlist and the prompt.
//
// Rules this module keeps, each for a reason:
//  - PRESENCE reads only the user's OWN config: the node account's Claude config dir (managed and
//    linked accounts REPLACE `~/.claude`, so the system dir is never consulted for them — a bad id
//    resolves to no dir and reads `unknown`, never the system dir in its place), and the skills dirs
//    the agent reads (`~/.agents/skills`, plus the agent's own). A repository file never makes
//    agent-sessions count as installed. For claude only KEY NAMES and an install's scope are read:
//    `installed_plugins.json`'s `plugins` entry for `sessions@agent-sessions` (a project-scoped install
//    counts only for that project), and `enabledPlugins` naming it `false`.
//  - The REPOSITORY is checked only to REFUSE (`repoShadow`): agents load project skills and
//    commands by name too, so a repo that ships `.agents/skills/agent-sessions`, its own
//    `/sessions:push`, or its own `agent-sessions` marketplace could put its copy in front of the
//    user's. Walked from the node's cwd up to the repository root (never the home dir or above), read
//    WITHOUT following links; a link or an unreadable entry is `unknown`, which refuses too.
//  - THREE-VALUED. A file that is not there is `absent`; one that is there but cannot be read or
//    parsed is `unknown` (a failed read is never evidence of absence), and the row stays disabled.
//  - INERT WHEN ABSENT: an `absent` answer skips the repository walk entirely.
//  - The shared-sessions LISTING treats the repository as HOSTILE (anyone with push access wrote
//    it): `.claude/sessions` must resolve inside the repository, a folder must be a real directory
//    (lstat — a symlink is skipped) whose name passes the strict allowlist and which holds NO link
//    and no non-regular `meta.json` / `summary.md` / `transcript*.md` (any of those poisons the whole
//    folder: the continue prompt names files the agent will open), `meta.json` must be a regular file
//    opened without following a link, size-capped, and every field becomes one display line through
//    `untrustedLine`. Bounded: directory entries scanned, folders read, entries per folder, bytes per
//    file and bytes in total are all capped. Read on demand only (a palette open), never on a timer.
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
  SHARED_SESSION_TRANSCRIPTS_MAX,
  SHARED_SESSIONS_MAX,
  SHARED_SESSIONS_SCAN_MAX,
  SHARED_SESSIONS_TOTAL_MAX_BYTES,
  isSafeSharedSessionDir,
  isSafeTranscriptFile,
  sharedSessionAgent,
  sharedSessionDirDate,
  type AgentSessionsAgent,
  type AgentSessionsDetectRequest,
  type AgentSessionsDetectResult,
  type AgentSessionsPresence,
  type RepoShadow,
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
import { parseFrontmatter } from './chat-catalog'

// Absent on Windows; there the name is lstat'ed first and compared with the handle we read.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0

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

/** Same directory? Resolved, and case-folded where the platform's filesystem folds case by default. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/** `cwd` and every directory above it — the places a project-scoped install could have been made. */
function selfAndAncestors(cwd: string): string[] {
  const out: string[] = []
  let d = path.resolve(cwd)
  for (let i = 0; i < 64; i++) {
    out.push(d)
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/**
 * `installed_plugins.json` keys its `plugins` object by `name@marketplace`. In the version-1 shape the
 * value is one object (a user-wide install); in version 2 it is a LIST of installs, each with a
 * `scope` and, for `project` / `local`, the `projectPath` it was installed for (shape from Claude
 * Code's docs and the files it writes — read defensively, not measured on a machine with this
 * plugin). A project-scoped install counts only when the node runs in that project (its cwd or an
 * ancestor of it); any other scope (`user`, `managed`, none) counts everywhere. Only the key, `scope`
 * and `projectPath` are read — never paths to execute or versions.
 */
export function pluginInstalled(installed: unknown, cwd?: string): boolean {
  if (!isRecord(installed) || !isRecord(installed.plugins) || !Object.hasOwn(installed.plugins, AGENT_SESSIONS_CLAUDE_PLUGIN)) {
    return false
  }
  const entry = installed.plugins[AGENT_SESSIONS_CLAUDE_PLUGIN]
  if (!Array.isArray(entry)) return isRecord(entry)
  const here = cwd && path.isAbsolute(cwd) ? selfAndAncestors(cwd) : []
  return entry.some((e) => {
    if (!isRecord(e)) return false
    if (e.scope !== 'project' && e.scope !== 'local') return true
    return typeof e.projectPath === 'string' && path.isAbsolute(e.projectPath) && here.some((d) => samePath(d, e.projectPath as string))
  })
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

async function detectClaudePlugin(
  accountId: string | undefined,
  cwd: string | undefined,
  roots: AgentSessionsRoots
): Promise<AgentSessionsPresence> {
  const dir = roots.claudeConfigDir(accountId)
  if (!dir) return 'unknown'
  const installed = await readUserJson(path.join(dir, 'plugins', 'installed_plugins.json'))
  if (installed.kind === 'absent') return 'absent'
  if (installed.kind === 'unreadable') return 'unknown'
  if (!pluginInstalled(installed.value, cwd)) return 'absent'
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

export async function detectPresence(
  req: AgentSessionsDetectRequest,
  roots: AgentSessionsRoots = defaultAgentSessionsRoots()
): Promise<AgentSessionsPresence> {
  if (req.agent === 'claude') return detectClaudePlugin(req.accountId, req.cwd, roots)
  let unknown = false
  for (const file of skillCandidates(req.agent, req.accountId, roots)) {
    const state = await fileState(file)
    if (state === 'present') return 'present'
    if (state === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'absent'
}

/** Presence, then — only when agent-sessions is not absent and a cwd was given — the repository
 *  check. Absent costs the presence stats and nothing else. */
export async function detectAgentSessions(
  req: AgentSessionsDetectRequest,
  roots: AgentSessionsRoots = defaultAgentSessionsRoots()
): Promise<{ presence: AgentSessionsPresence; shadow?: RepoShadow }> {
  const presence = await detectPresence(req, roots)
  if (presence === 'absent' || req.cwd === undefined) return { presence }
  return { presence, shadow: await repoShadow(req.agent, req.cwd, roots.home) }
}

// ── A repository copy that could run instead of the user's ───────────────────────────────────

/** Entries read per project skills / commands dir; a bigger one cannot be judged (`unknown`). */
export const SHADOW_DIR_MAX_ENTRIES = 256
/** Bytes of a project SKILL.md read for its frontmatter `name`. */
const SHADOW_HEAD_BYTES = 4096
/** Directory levels walked from the cwd toward the repository root. */
const SHADOW_WALK_MAX = 16

/** The project skill dirs each agent loads by name (relative to a project directory). From each
 *  agent's docs (Gemini: workspace `.gemini/skills` and `.agents/skills`; OpenCode: `.opencode/skills`,
 *  `.opencode/skill`, the Claude-compatible `.claude/skills` and `.agents/skills`; Codex: `.agents/skills`
 *  and its older `.codex/skills`), not all measured — a dir an agent does not read only costs a
 *  refusal in a repository that has one. */
const PROJECT_SKILL_DIRS: Record<AgentSessionsAgent, readonly (readonly string[])[]> = {
  claude: [['.claude', 'skills']],
  codex: [['.agents', 'skills'], ['.codex', 'skills']],
  gemini: [['.gemini', 'skills'], ['.agents', 'skills']],
  opencode: [['.opencode', 'skills'], ['.opencode', 'skill'], ['.claude', 'skills'], ['.agents', 'skills']]
}

/** What a repository copy would be NAMED: the portable skill, or claude's namespaced command
 *  (`.claude/commands/sessions/push.md` is `/sessions:push` — the measured `dir:name` rule). */
const CLAUDE_COMMAND = 'sessions:push'

const isAbsentCode = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.toLowerCase()
const worst = (a: RepoShadow, b: RepoShadow): RepoShadow =>
  a === 'present' || b === 'present' ? 'present' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'none'

/** The directories a project definition could come from: the cwd and each parent up to and
 *  including the repository root (the first one holding `.git`) — never the home directory or
 *  anything above it, where the USER's own `~/.agents/skills` lives. */
export async function shadowWalk(cwd: string, home: string): Promise<string[] | null> {
  if (!path.isAbsolute(cwd)) return null
  const homeDir = path.resolve(home)
  const out: string[] = []
  let d = path.resolve(cwd)
  for (let i = 0; i < SHADOW_WALK_MAX; i++) {
    if (samePath(d, homeDir) || isStrictlyInside(homeDir, d)) break
    out.push(d)
    try {
      await fs.promises.lstat(path.join(d, '.git'))
      break // the repository root
    } catch (e) {
      if (!isAbsentCode(e)) return null
    }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/** `base/<segs…>` as a real directory reached without a link: its entries, `none` when it is not
 *  there, `unknown` when a component is a link (the agent would follow it; we do not) or it cannot
 *  be listed within the cap. */
async function listProjectDir(base: string, segs: readonly string[]): Promise<fs.Dirent[] | 'none' | 'unknown'> {
  let p = base
  for (const seg of segs) {
    p = path.join(p, seg)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(p)
    } catch (e) {
      return isAbsentCode(e) ? 'none' : 'unknown'
    }
    if (st.isSymbolicLink()) return 'unknown'
    if (!st.isDirectory()) return 'none'
  }
  const out: fs.Dirent[] = []
  try {
    const dir = await fs.promises.opendir(p)
    for await (const e of dir) {
      if (out.length >= SHADOW_DIR_MAX_ENTRIES) return 'unknown'
      out.push(e)
    }
  } catch {
    return 'unknown'
  }
  return out
}

/** A project SKILL.md's head, read without following a link: text, `absent`, or `not-regular`. */
async function readProjectHead(file: string): Promise<string | 'absent' | 'not-regular'> {
  let named: fs.Stats
  try {
    named = await fs.promises.lstat(file)
  } catch (e) {
    return isAbsentCode(e) ? 'absent' : 'not-regular'
  }
  if (!named.isFile()) return 'not-regular'
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return 'not-regular'
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return 'not-regular'
    const buf = Buffer.alloc(Math.min(SHADOW_HEAD_BYTES, st.size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return 'not-regular'
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Does this project skills dir hold a skill NAMED `target` — by folder or by frontmatter `name`
 *  (agents match the frontmatter name)? A linked entry cannot be judged without following it. */
async function skillsDirShadow(base: string, segs: readonly string[], target: string): Promise<RepoShadow> {
  const entries = await listProjectDir(base, segs)
  if (entries === 'none' || entries === 'unknown') return entries
  let verdict: RepoShadow = 'none'
  for (const e of entries) {
    if (sameName(e.name, target)) return 'present'
    if (e.isSymbolicLink()) {
      verdict = 'unknown'
      continue
    }
    if (!e.isDirectory()) continue
    const head = await readProjectHead(path.join(base, ...segs, e.name, 'SKILL.md'))
    if (head === 'absent') continue
    if (head === 'not-regular') {
      verdict = 'unknown'
      continue
    }
    const name = parseFrontmatter(head).fields.name
    if (name && sameName(name, target)) return 'present'
  }
  return verdict
}

/** claude: a project command that would be `/sessions:push` — `.claude/commands/sessions/…` or a file
 *  named `sessions:…`. Matched by name only; nothing inside is read. */
async function claudeCommandShadow(base: string): Promise<RepoShadow> {
  const entries = await listProjectDir(base, ['.claude', 'commands'])
  if (entries === 'none' || entries === 'unknown') return entries
  return entries.some((e) => sameName(e.name, 'sessions') || e.name.toLowerCase().startsWith('sessions:')) ? 'present' : 'none'
}

/** The marketplace agent-sessions' own `init` registers in a repository's `.claude/settings.json`.
 *  A repository that declares an `agent-sessions` marketplace pointing ANYWHERE ELSE could make
 *  `sessions@agent-sessions` resolve to its own plugin (how Claude Code settles two marketplaces of
 *  one name was not measured), so that is a refusal; the tool's own entry is not. */
const AGENT_SESSIONS_MARKETPLACE_REPO = 'prajwalgajakesari/agent-sessions'

async function claudeMarketplaceShadow(base: string): Promise<RepoShadow> {
  let verdict: RepoShadow = 'none'
  for (const name of ['settings.json', 'settings.local.json']) {
    const text = await readProjectHead(path.join(base, '.claude', name))
    if (text === 'absent') continue
    if (text === 'not-regular') {
      verdict = 'unknown'
      continue
    }
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      // Larger than the head, or broken: it cannot be judged.
      verdict = 'unknown'
      continue
    }
    const markets = isRecord(doc) ? doc.extraKnownMarketplaces : undefined
    if (!isRecord(markets) || !Object.hasOwn(markets, 'agent-sessions')) continue
    const m = markets['agent-sessions']
    const src = isRecord(m) ? m.source : undefined
    const ours =
      isRecord(src) &&
      src.source === 'github' &&
      typeof src.repo === 'string' &&
      src.repo.toLowerCase() === AGENT_SESSIONS_MARKETPLACE_REPO
    if (!ours) return 'present'
  }
  return verdict
}

/** Could the repository the node runs in put its own copy in front of the user's agent-sessions? */
export async function repoShadow(agent: AgentSessionsAgent, cwd: string, home: string): Promise<RepoShadow> {
  const dirs = await shadowWalk(cwd, home)
  if (!dirs) return 'unknown'
  let verdict: RepoShadow = 'none'
  for (const d of dirs) {
    const target = agent === 'claude' ? CLAUDE_COMMAND : AGENT_SESSIONS_SKILL
    for (const segs of PROJECT_SKILL_DIRS[agent]) verdict = worst(verdict, await skillsDirShadow(d, segs, target))
    if (agent === 'claude') {
      verdict = worst(verdict, await claudeCommandShadow(d))
      verdict = worst(verdict, await claudeMarketplaceShadow(d))
    }
    if (verdict === 'present') return verdict
  }
  return verdict
}

/** Sanitize a detect request that arrived over IPC / the WS bridge. */
export function normalizeDetectRequest(raw: unknown): AgentSessionsDetectRequest | null {
  if (!isRecord(raw)) return null
  const agent = raw.agent
  if (typeof agent !== 'string' || !(AGENT_SESSIONS_AGENTS as readonly string[]).includes(agent)) return null
  const accountId = typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : undefined
  const cwd = typeof raw.cwd === 'string' && raw.cwd.length <= 4096 && path.isAbsolute(raw.cwd) ? raw.cwd : undefined
  return { agent: agent as AgentSessionsAgent, ...(accountId ? { accountId } : {}), ...(cwd ? { cwd } : {}) }
}

// ── Shared sessions in a repository ───────────────────────────────────────────────────────────

/** `pushed_at` / `started` as agent-sessions writes them (ISO 8601). Anything else is ignored. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+\-Z]{0,40})?$/


/** Entries read per session folder; agent-sessions writes 3 + its transcript parts. */
export const SHARED_SESSION_FOLDER_MAX_ENTRIES = 64

/**
 * What one session folder holds, judged WITHOUT following anything: `null` (poisoned — never listed)
 * when it holds a link of any kind, or a `meta.json` / `summary.md` / `transcript*.md` (any case) that
 * is not a regular file — a committed `transcript.md -> ~/.ssh/id_rsa` would otherwise be a file the
 * continue prompt sends the agent to — or more entries than agent-sessions ever writes. Otherwise the
 * regular files the prompt may name.
 */
export async function sessionFolderFiles(
  folder: string
): Promise<{ hasMeta: boolean; hasSummary: boolean; transcriptFiles: string[] } | null> {
  const entries: fs.Dirent[] = []
  try {
    const dir = await fs.promises.opendir(folder)
    for await (const e of dir) {
      if (entries.length >= SHARED_SESSION_FOLDER_MAX_ENTRIES) return null
      entries.push(e)
    }
  } catch {
    return null
  }
  let hasMeta = false
  let hasSummary = false
  const transcriptFiles: string[] = []
  for (const e of entries) {
    // A filesystem that reports no type is asked directly; still never through a link.
    let kind: 'file' | 'link' | 'other'
    if (e.isSymbolicLink()) kind = 'link'
    else if (e.isFile()) kind = 'file'
    else if (e.isDirectory() || e.isFIFO() || e.isSocket() || e.isBlockDevice() || e.isCharacterDevice()) kind = 'other'
    else {
      try {
        const st = await fs.promises.lstat(path.join(folder, e.name))
        kind = st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'
      } catch {
        return null
      }
    }
    if (kind === 'link') return null
    const lower = e.name.toLowerCase()
    const named = lower === 'meta.json' || lower === 'summary.md' || /^transcript.*\.md$/.test(lower)
    if (named && kind !== 'file') return null
    if (kind !== 'file') continue
    if (e.name === 'meta.json') hasMeta = true
    else if (e.name === 'summary.md') hasSummary = true
    else if (isSafeTranscriptFile(e.name)) transcriptFiles.push(e.name)
  }
  const part = (n: string): number => (n === 'transcript.md' ? 0 : Number(n.slice('transcript-'.length, -'.md'.length)))
  transcriptFiles.sort((a, b) => part(a) - part(b))
  return { hasMeta, hasSummary, transcriptFiles: transcriptFiles.slice(0, SHARED_SESSION_TRANSCRIPTS_MAX) }
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
  files: { hasSummary: boolean; transcriptFiles: string[] }
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
    transcriptFiles: files.transcriptFiles,
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
    const files = await sessionFolderFiles(folder)
    if (!files?.hasMeta) return null
    const meta = await readMeta(path.join(folder, 'meta.json'), budget)
    if (!meta) return null
    return sharedSessionFromMeta(name, meta, files)
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
      return { ok: true, ...(await detectAgentSessions(req, roots())) }
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
