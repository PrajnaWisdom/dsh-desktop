// @dsh-desktop/dsh-skills-mcp-manager — host half
// First-party Skills & MCP manager for the dsh desktop web GUI.
// Mounts a skills filesystem engine, an MCP connection manager (real
// @deepseek-ai/dsh-mcp-client fibers per enabled server), the
// /api/skills-mcp route family, and a system-prompt announcement.
// The browser half (./client) renders a theme-aware settings section using
// the shell's --dsw-* design tokens.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import z from 'schemastery'

// ---------- API paths (shared with the browser half) ----------
const API = {
  skills: '/api/skills-mcp/skills',
  skillRead: '/api/skills-mcp/skills/read',
  skillToggle: '/api/skills-mcp/skills/toggle',
  skillDelete: '/api/skills-mcp/skills/delete',
  skillScan: '/api/skills-mcp/skills/scan',
  skillImport: '/api/skills-mcp/skills/import',
  mcp: '/api/skills-mcp/mcp',
  mcpSave: '/api/skills-mcp/mcp/save',
  mcpEnabled: '/api/skills-mcp/mcp/enabled',
  mcpDelete: '/api/skills-mcp/mcp/delete',
  mcpTest: '/api/skills-mcp/mcp/test',
}

// ---------- skills engine ----------
function dshHomeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function agentsHomeDir() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}
function getRoots() {
  const dshHome = dshHomeDir()
  const agentsHome = agentsHomeDir()
  const userSkillsDir = join(dshHome, 'skills')
  mkdirSync(userSkillsDir, { recursive: true })
  return { dshHome, agentsHome, userSkillsDir, agentsSkillsDir: join(agentsHome, 'skills') }
}
function findProjectRoot(cwd) {
  let dir = resolve(cwd || process.cwd())
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}
function levelOf(source) {
  return source === 'project-dsh' || source === 'project-agents' ? 'project' : 'user'
}
function scalarValue(v) {
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  return v
}
function parseBool(v) {
  if (v === true || v === 1 || v === '1') return true
  if (v === false || v === 0 || v === '0') return false
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    if (s === 'true' || s === 'yes' || s === 'on') return true
    if (s === 'false' || s === 'no' || s === 'off') return false
  }
  return undefined
}
function parseFrontmatter(raw) {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return null
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break }
  }
  if (closeIdx < 0) return null
  const data = {}
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1)
    }
    data[key] = scalarValue(val)
  }
  return { data, body: lines.slice(closeIdx + 1).join('\n') }
}
function parseSkillFile(raw) {
  const fm = parseFrontmatter(raw)
  if (fm === null) return null
  const name = typeof fm.data.name === 'string' ? fm.data.name : ''
  const description = typeof fm.data.description === 'string' ? fm.data.description : ''
  if (name === '' || description === '') return null
  const whenToUse = typeof fm.data.whenToUse === 'string' ? fm.data.whenToUse : ''
  const disableModel = parseBool(fm.data['disable-model-invocation'])
  const userInvocable = parseBool(fm.data['user-invocable'])
  return {
    name,
    description,
    whenToUse,
    enabled: (disableModel !== true) || (userInvocable !== false),
    content: fm.body.trim(),
  }
}
function toggleInvocation(raw, enabled) {
  const lines = raw.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return raw
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { closeIdx = i; break } }
  if (closeIdx < 0) return raw
  const kept = lines.slice(1, closeIdx).filter((l) => {
    return !/^\s*(disable-model-invocation|disableModelInvocation|modelInvocable|user-invocable|userInvocable)\s*:/.test(l)
  })
  if (!enabled) { kept.push('disable-model-invocation: true'); kept.push('user-invocable: false') }
  return [lines[0]].concat(kept, lines.slice(closeIdx)).join('\n')
}

class SkillsManager {
  scanRoot(dir, source) {
    const items = []
    if (!existsSync(dir)) return items
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return items }
    for (const entry of entries) {
      const name = entry.name
      if (!name || name === '.system' || name[0] === '.') continue
      if (entry.isDirectory()) {
        const mdPath = join(dir, name, 'SKILL.md')
        if (!existsSync(mdPath)) continue
        let raw
        try { raw = readFileSync(mdPath, 'utf8') } catch { continue }
        const parsed = parseSkillFile(raw)
        if (parsed === null) continue
        items.push({ ...parsed, source, level: levelOf(source), kind: 'bundle', path: mdPath })
      } else if (entry.isFile() && name.endsWith('.md')) {
        const filePath = join(dir, name)
        let raw
        try { raw = readFileSync(filePath, 'utf8') } catch { continue }
        const parsed = parseSkillFile(raw)
        if (parsed === null) continue
        items.push({ ...parsed, source, level: levelOf(source), kind: 'file', path: filePath })
      }
    }
    return items
  }
  listSkills(cwd) {
    const roots = getRoots()
    const scans = []
    if (cwd) {
      const projectRoot = findProjectRoot(cwd)
      scans.push(
        { path: join(projectRoot, '.dsh', 'skills'), source: 'project-dsh' },
        { path: join(projectRoot, '.agents', 'skills'), source: 'project-agents' },
        { path: roots.userSkillsDir, source: 'user-dsh' },
        { path: roots.agentsSkillsDir, source: 'user-agents' },
      )
    } else {
      scans.push(
        { path: roots.userSkillsDir, source: 'user-dsh' },
        { path: roots.agentsSkillsDir, source: 'user-agents' },
      )
    }
    const seen = new Set()
    const items = []
    for (const s of scans) {
      for (const it of this.scanRoot(s.path, s.source)) {
        if (seen.has(it.path)) continue
        seen.add(it.path)
        items.push(it)
      }
    }
    items.sort((a, b) => {
      if (a.level !== b.level) return a.level === 'project' ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    return items
  }
  readSkill(path) {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    const parsed = parseSkillFile(raw)
    if (parsed === null) return null
    return { ...parsed, path }
  }
  setSkillEnabled(path, enabled) {
    const raw = readFileSync(path, 'utf8')
    writeFileSync(path, toggleInvocation(raw, enabled), 'utf8')
  }
  deleteSkill(path, kind) {
    const target = kind === 'bundle' ? dirname(path) : path
    rmSync(target, { recursive: true, force: true })
    return target
  }
  scanSkills(dir) {
    if (!existsSync(dir)) throw new Error('directory not found: ' + dir)
    const entries = readdirSync(dir, { withFileTypes: true })
    const items = []
    for (const entry of entries) {
      const name = entry.name
      if (!name || name[0] === '.') continue
      if (entry.isDirectory()) {
        const mdPath = join(dir, name, 'SKILL.md')
        if (!existsSync(mdPath)) continue
        let raw
        try { raw = readFileSync(mdPath, 'utf8') } catch { continue }
        const parsed = parseSkillFile(raw)
        if (parsed !== null) items.push({ name: parsed.name, description: parsed.description, sourcePath: join(dir, name), kind: 'bundle' })
      } else if (entry.isFile() && name.endsWith('.md') && name !== 'SKILL.md') {
        let raw
        try { raw = readFileSync(join(dir, name), 'utf8') } catch { continue }
        const parsed = parseSkillFile(raw)
        if (parsed !== null) items.push({ name: parsed.name, description: parsed.description, sourcePath: join(dir, name), kind: 'file' })
      }
    }
    return items
  }
  async importSkills(items) {
    const destDir = getRoots().userSkillsDir
    mkdirSync(destDir, { recursive: true })
    const results = []
    for (const it of items) {
      const base = join(destDir, it.sourcePath.split(/[\\/]/).pop() || '')
      if (existsSync(base)) {
        results.push({ name: base, ok: false, reason: 'already exists' })
        continue
      }
      try {
        // 用异步 cp/copyFile（线程池执行）而非同步 cpSync：同步复制会阻塞
        // 事件循环，与 sidecar 的 stdio 管线（大响应写入、订阅帧转发）相互作用，
        // 触发 node 的 V8 原生栈溢出（0xC0000409）崩溃。
        if (it.kind === 'bundle') await cp(it.sourcePath, base, { recursive: true })
        else await copyFile(it.sourcePath, base)
        results.push({ name: base, ok: true })
      } catch (e) {
        results.push({ name: base, ok: false, reason: String(e?.message ?? e) })
      }
    }
    return results
  }
}

// ---------- MCP engine ----------
const TOOL_CALL_TIMEOUT_MS = 60_000
const RECONNECT = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }

function mcpConfigPath() {
  return join(dshHomeDir(), 'mcp.json')
}
function readMcpConfig() {
  const target = mcpConfigPath()
  try {
    if (!existsSync(target)) return { servers: [] }
    const raw = readFileSync(target, 'utf8')
    if (!raw || raw.trim() === '') return { servers: [] }
    const data = JSON.parse(raw)
    return { servers: Array.isArray(data.servers) ? data.servers : [] }
  } catch {
    return { servers: [] }
  }
}
function writeMcpConfig(data) {
  const target = mcpConfigPath()
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
}
function validateMcpServer(server) {
  if (!server || typeof server !== 'object') return 'server must be an object'
  const name = server.name
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return 'invalid name (1-32 chars of A-Za-z0-9_-)'
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') return "transport must be 'stdio' or 'streamable-http'"
  if (server.transport === 'stdio' && (typeof server.command !== 'string' || server.command.trim() === '')) return 'stdio transport requires command'
  if (server.transport === 'streamable-http' && (typeof server.url !== 'string' || server.url.trim() === '')) return 'streamable-http transport requires url'
  return null
}
function normalizeMcpServer(server) {
  const normalized = { name: server.name, transport: server.transport, enabled: server.enabled !== false }
  if (server.transport === 'stdio') {
    normalized.command = server.command
    normalized.args = Array.isArray(server.args) ? server.args : []
    normalized.env = (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) ? server.env : {}
    normalized.cwd = server.cwd || ''
  } else {
    normalized.url = server.url
    normalized.headers = (server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)) ? server.headers : {}
  }
  return normalized
}
function toMcpClientConfig(s) {
  const base = { serverName: s.name, toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS, failOnStartupError: true, reconnect: RECONNECT }
  if (s.transport === 'stdio') {
    return { ...base, transport: 'stdio', command: s.command ?? '', args: s.args ?? [], env: s.env ?? {}, cwd: s.cwd ?? '' }
  }
  return { ...base, transport: 'streamable-http', url: s.url ?? '', headers: s.headers ?? {} }
}
function configChanged(a, b) {
  return JSON.stringify(normalizeMcpServer(a)) !== JSON.stringify(normalizeMcpServer(b))
}

class McpManager {
  constructor(ctx) {
    this.ctx = ctx
    this.live = new Map()
    this.statuses = new Map()
  }
  async reload() {
    await this.sync(readMcpConfig().servers)
  }
  async sync(servers) {
    const next = new Map()
    for (const s of servers) {
      if (s.enabled !== false) next.set(s.name, s)
    }
    for (const [name, entry] of [...this.live]) {
      const target = next.get(name)
      if (target === undefined || configChanged(entry.config, target)) {
        this.live.delete(name)
        this.statuses.delete(name)
        try { await entry.fiber.dispose() } catch { /* already gone */ }
      }
    }
    for (const [name, cfg] of next) {
      if (this.live.has(name)) continue
      this.statuses.set(name, { status: 'connecting' })
      let fiber
      try {
        fiber = this.ctx.plugin(mcpClient, toMcpClientConfig(cfg))
      } catch (e) {
        this.statuses.set(name, { status: 'failed', error: String(e?.message ?? e) })
        continue
      }
      this.live.set(name, { config: normalizeMcpServer(cfg), fiber })
      fiber.then(
        () => { this.statuses.set(name, { status: 'running' }) },
        (e) => {
          this.live.delete(name)
          this.statuses.set(name, { status: 'failed', error: String(e?.message ?? e) })
        },
      )
    }
  }
  async dispose() {
    for (const [name, entry] of [...this.live]) {
      this.live.delete(name)
      this.statuses.delete(name)
      try { await entry.fiber.dispose() } catch { /* already gone */ }
    }
  }
  async testConnect(server) {
    const normalized = normalizeMcpServer(server)
    if (this.live.has(normalized.name)) return { ok: true }
    const fiber = this.ctx.plugin(mcpClient, toMcpClientConfig(normalized))
    try {
      await fiber
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    } finally {
      try { await fiber.dispose() } catch { /* already gone */ }
    }
  }
  summarize(servers) {
    return servers.map((s) => {
      const st = this.statuses.get(s.name)
      const enabled = s.enabled !== false
      const status = !enabled ? 'stopped' : (st?.status ?? 'connecting')
      return { ...s, enabled, status, error: st?.error }
    })
  }
}

// ---------- routes ----------
const MAX_JSON_BODY_BYTES = 1024 * 1024

function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}
function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}
const ok = (payload) => ({ ok: true, ...payload })

function makeRoutes({ skills, mcp }) {
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return false
    }
    return true
  }
  const handle = (method, path, fn) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!guard(req, res, method)) return
      let body = {}
      if (method === 'POST') {
        const parsed = await readJsonBody(req)
        if (parsed === undefined) { writeJson(res, 400, { ok: false, error: 'invalid or oversized JSON body' }); return }
        body = parsed
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      try {
        await fn(req, res, body, url)
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    },
  })

  return [
    handle('GET', API.skills, async (_req, res, _body, url) => {
      writeJson(res, 200, ok({ items: skills.listSkills(queryParam(url, 'cwd')) }))
    }),
    handle('POST', API.skillRead, async (_req, res, body) => {
      const path = typeof body.path === 'string' ? body.path : ''
      if (!path) { writeJson(res, 400, { ok: false, error: 'path required' }); return }
      const skill = skills.readSkill(path)
      if (skill === null) { writeJson(res, 404, { ok: false, error: 'not a valid skill file: ' + path }); return }
      writeJson(res, 200, ok({ skill }))
    }),
    handle('POST', API.skillToggle, async (_req, res, body) => {
      const path = typeof body.path === 'string' ? body.path : ''
      if (!path) { writeJson(res, 400, { ok: false, error: 'path required' }); return }
      skills.setSkillEnabled(path, body.enabled !== false)
      writeJson(res, 200, ok({ path, enabled: body.enabled !== false }))
    }),
    handle('POST', API.skillDelete, async (_req, res, body) => {
      const path = typeof body.path === 'string' ? body.path : ''
      if (!path) { writeJson(res, 400, { ok: false, error: 'path required' }); return }
      const kind = body.kind === 'file' ? 'file' : 'bundle'
      const removed = skills.deleteSkill(path, kind)
      writeJson(res, 200, ok({ path, removed }))
    }),
    handle('POST', API.skillScan, async (_req, res, body) => {
      const dir = typeof body.dir === 'string' ? body.dir : ''
      if (!dir) { writeJson(res, 400, { ok: false, error: 'directory is required' }); return }
      writeJson(res, 200, ok({ items: skills.scanSkills(dir) }))
    }),
    handle('POST', API.skillImport, async (_req, res, body) => {
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) { writeJson(res, 400, { ok: false, error: 'nothing selected' }); return }
      writeJson(res, 200, ok({ results: await skills.importSkills(items) }))
    }),
    handle('GET', API.mcp, async (_req, res) => {
      writeJson(res, 200, ok({ servers: mcp.summarize(readMcpConfig().servers) }))
    }),
    handle('POST', API.mcpSave, async (_req, res, body) => {
      const err = validateMcpServer(body.server)
      if (err) { writeJson(res, 400, { ok: false, error: err }); return }
      const normalized = normalizeMcpServer(body.server)
      const data = readMcpConfig()
      const idx = data.servers.findIndex((x) => x.name === normalized.name)
      if (idx >= 0) data.servers[idx] = normalized
      else data.servers.push(normalized)
      writeMcpConfig(data)
      await mcp.sync(data.servers)
      writeJson(res, 200, ok({ server: normalized }))
    }),
    handle('POST', API.mcpEnabled, async (_req, res, body) => {
      const name = typeof body.name === 'string' ? body.name : ''
      if (!name) { writeJson(res, 400, { ok: false, error: 'name required' }); return }
      const data = readMcpConfig()
      const target = data.servers.find((x) => x.name === name)
      if (!target) { writeJson(res, 404, { ok: false, error: 'server not found: ' + name }); return }
      target.enabled = body.enabled !== false
      writeMcpConfig(data)
      await mcp.sync(data.servers)
      writeJson(res, 200, ok({ name, enabled: target.enabled }))
    }),
    handle('POST', API.mcpDelete, async (_req, res, body) => {
      const name = typeof body.name === 'string' ? body.name : ''
      if (!name) { writeJson(res, 400, { ok: false, error: 'name required' }); return }
      const data = readMcpConfig()
      data.servers = data.servers.filter((x) => x.name !== name)
      writeMcpConfig(data)
      await mcp.sync(data.servers)
      writeJson(res, 200, ok({ name }))
    }),
    handle('POST', API.mcpTest, async (_req, res, body) => {
      const err = validateMcpServer(body.server)
      if (err) { writeJson(res, 400, { ok: false, error: err }); return }
      const result = await mcp.testConnect(body.server)
      writeJson(res, 200, ok({ test: result }))
    }),
  ]
}

// ---------- plugin ----------
const name = 'dsh-skills-mcp-manager'
const inject = ['webServer', 'tools', 'systemPrompt']

const SKILLS_MCP_NAMESPACE = settingsNamespace('dsh-skills-mcp-manager')
const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
})

const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true
const SECTION_ORDER = 160

const SKILLS_MCP_GUIDANCE =
  '本机已安装 dsh-skills-mcp-manager 插件（技能与 MCP 管理器）：设置页「技能与 MCP」。能力：浏览/启用/禁用/删除/导入技能（项目级 .dsh/skills、.agents/skills 与用户级 ~/.dsh/skills、~/.agents/skills）；管理 MCP 服务器（stdio 与 streamable-http），启用即真实连接并把工具注册为 mcp__<server>__<tool>。限制：MCP 配置存 ~/.dsh/mcp.json；技能启用/禁用通过改写 SKILL.md 前言实现；删除为物理删除不可恢复。用户提到「技能管理 / 技能导入 / MCP 服务器」时即指本插件。'

function apply(ctx, config) {
  let current = () => config ?? {}
  const resolve = () => ({
    enabled: current().enabled ?? DEFAULT_ENABLED,
    announceToAgent: current().announceToAgent ?? DEFAULT_ANNOUNCE,
  })

  const skills = new SkillsManager()
  const mcp = new McpManager(ctx)
  const routes = makeRoutes({ skills, mcp })

  let disposeSection
  let disposeRoutes

  const sync = () => {
    const value = resolve()
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (!value.enabled) { void mcp.dispose(); return }
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-skills-mcp-manager',
        order: SECTION_ORDER,
        text: SKILLS_MCP_GUIDANCE,
      })
    }
    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-skills-mcp-manager: routes')
    void mcp.reload()
  }

  installSettingsSection(ctx, SKILLS_MCP_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source; sync() },
    onChange: sync,
  })

  ctx.effect(() => () => { void mcp.dispose() }, 'dsh-skills-mcp-manager: mcp')

  sync()
}

export { API, Config, SKILLS_MCP_NAMESPACE, apply, inject, name }
