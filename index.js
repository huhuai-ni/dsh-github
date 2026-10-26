/**
 * dsh-github —— 让 DSH 直接管理 GitHub 账号的插件
 * ============================================================================
 * 能力：
 *   · 看自己是谁（github_whoami）
 *   · 列仓库 / 看单仓 / 搜仓库
 *   · 列 issue / 建 issue / 列 PR
 *   · 列通知、列 Actions 运行、star / unstar
 *   · 设置 token（github_set_token），存 ~/.dsh/github-manager/config.json
 *
 * Token 来源优先级：config.json > 环境变量 GITHUB_TOKEN / GH_TOKEN
 * 需要的权限（经典 PAT）：repo（私人仓库）或 public_repo（只公共）；
 * 细粒度 PAT：Contents / Issues / Pull requests / Metadata 读权限即可。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import https from 'node:https'
import tls from 'node:tls'

export const name = 'github-manager'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(DSH_HOME, 'github-manager')
const CFG_FILE = join(DIR, 'config.json')

function readCfg() {
  try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')) } catch { return {} }
}
function writeCfg(obj) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(CFG_FILE, JSON.stringify(obj, null, 2), 'utf8')
}
function getToken() {
  return readCfg().token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

/**
 * 这台机器有做 TLS 拦截的安全软件（Node 内置 CA 不认它的根证书），
 * 所以走系统证书库。tls.getCACertificates('system') 需要 Node 22+。
 */
let CA_CACHE = null
function caBundle() {
  if (CA_CACHE) return CA_CACHE
  try { CA_CACHE = tls.getCACertificates('system') } catch { CA_CACHE = null }
  return CA_CACHE
}

function gh(path, init = {}) {
  const token = getToken()
  if (!token) return Promise.reject(new Error('还没有 GitHub Token：先调用 github_set_token，或把 token 写进 ' + CFG_FILE))
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com',
      path,
      method: init.method || 'GET',
      timeout: 25000,
      ca: caBundle() || undefined,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'User-Agent': 'dsh-github',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { raw += d })
      res.on('end', () => {
        let data
        try { data = JSON.parse(raw) } catch { data = raw }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data)
        const msg = typeof data === 'string' ? data.slice(0, 200) : (data?.message || JSON.stringify(data).slice(0, 300))
        reject(new Error(`GitHub ${res.statusCode}: ${msg}`))
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时（25s）')))
    req.on('error', (e) => reject(new Error('网络错误: ' + (e.code || e.message))))
    if (init.body) req.write(JSON.stringify(init.body))
    req.end()
  })
}

/** 精简仓库对象，避免工具返回几十 KB */
const slimRepo = (r) => ({
  full_name: r.full_name, private: r.private, description: r.description,
  stars: r.stargazers_count, forks: r.forks_count, language: r.language,
  updated_at: r.updated_at, default_branch: r.default_branch, html_url: r.html_url,
})
const slimIssue = (i) => ({
  number: i.number, title: i.title, state: i.state, user: i.user?.login,
  labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
  comments: i.comments, updated_at: i.updated_at, html_url: i.html_url,
  pull_request: !!i.pull_request,
})
const slimPR = (p) => ({
  number: p.number, title: p.title, state: p.state, user: p.user?.login,
  head: p.head?.ref, base: p.base?.ref, draft: p.draft, merged_at: p.merged_at,
  updated_at: p.updated_at, html_url: p.html_url,
})

/** 宿主 dsh-tools 不可得时的等价实现（与 dsh-bili-subagent 的做法一致） */
function localDefineTool(options) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  return options
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

async function loadDefineTool() {
  for (const p of ['@deepseek-ai/dsh-tools', 'dsh-tools']) {
    try {
      const m = await import(p)
      if (m?.defineTool) return m.defineTool
    } catch { /* 继续找 */ }
  }
  return localDefineTool
}

// cordis 的 apply 用同步签名最稳：异步 apply 在部分版本里不会被 await，
// 结果是工具一个都注册不上。桌面版拿不到 dsh-tools，直接用等价实现。
export function apply(ctx) {
  const defineTool = localDefineTool

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args) {
      try {
        return await spec.execute(args || {})
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  }))

  /* ————————————————— 账号 ————————————————— */

  tool({
    name: 'github_set_token',
    description: '保存 GitHub Personal Access Token 到本机配置（只写本地文件，不会发送到别处）。传空字符串可清除。',
    parameters: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'ghp_... 或 github_pat_...' },
        login: { type: 'string', description: '可选：你的 GitHub 用户名，方便记录' },
      },
      required: ['token'],
      additionalProperties: false,
    },
    async execute({ token, login }) {
      const cfg = readCfg()
      if (!token) {
        delete cfg.token
        writeCfg(cfg)
        return { ok: true, cleared: true, file: CFG_FILE }
      }
      cfg.token = String(token).trim()
      if (login) cfg.login = String(login).trim()
      cfg.saved_at = new Date().toISOString()
      writeCfg(cfg)
      const me = await gh('/user')
      cfg.login = me.login
      writeCfg(cfg)
      return { ok: true, login: me.login, name: me.name, file: CFG_FILE }
    },
  })

  tool({
    name: 'github_whoami',
    description: '查看当前 GitHub 账号（登录名、昵称、公开仓库数、粉丝数）。用来确认 token 是否有效。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const u = await gh('/user')
      return {
        ok: true, login: u.login, name: u.name, bio: u.bio,
        public_repos: u.public_repos, followers: u.followers, following: u.following,
        private_repos: u.total_private_repos, plan: u.plan?.name,
        html_url: u.html_url, created_at: u.created_at,
      }
    },
  })

  /* ————————————————— 仓库 ————————————————— */

  tool({
    name: 'github_repos',
    description: '列出当前账号的仓库（含私人），按最近更新时间排序。',
    parameters: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: '条数，默认 20，最多 100' },
        sort: { type: 'string', enum: ['updated', 'pushed', 'created', 'full_name'], description: '排序方式' },
        visibility: { type: 'string', enum: ['all', 'public', 'private'], description: '可见性' },
      },
      additionalProperties: false,
    },
    async execute({ per_page = 20, sort = 'updated', visibility = 'all' }) {
      const n = Math.min(Math.max(Number(per_page) || 20, 1), 100)
      const list = await gh(`/user/repos?per_page=${n}&sort=${sort}&affiliation=owner,collaborator&visibility=${visibility}`)
      return { ok: true, count: list.length, repos: list.map(slimRepo) }
    },
  })

  tool({
    name: 'github_repo',
    description: '查看单个仓库详情，例如 github_repo { repo: "owner/name" }。',
    parameters: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'owner/name' } },
      required: ['repo'],
      additionalProperties: false,
    },
    async execute({ repo }) {
      const r = await gh(`/repos/${repo}`)
      return {
        ok: true, ...slimRepo(r),
        open_issues: r.open_issues_count, size_kb: r.size,
        topics: r.topics, license: r.license?.spdx_id, homepage: r.homepage,
      }
    },
  })

  tool({
    name: 'github_search_repos',
    description: '搜 GitHub 仓库。例：github_search_repos { query: "yolo onnx language:python", sort: "stars" }',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，支持 GitHub 语法' },
        sort: { type: 'string', enum: ['best-match', 'stars', 'forks', 'updated'], description: '排序' },
        per_page: { type: 'number', description: '条数，默认 10' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute({ query, sort = 'best-match', per_page = 10 }) {
      const n = Math.min(Math.max(Number(per_page) || 10, 1), 50)
      const s = sort === 'best-match' ? '' : `&sort=${sort}`
      const r = await gh(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${n}${s}`)
      return { ok: true, total: r.total_count, items: (r.items || []).map(slimRepo) }
    },
  })

  /* ————————————————— Issue / PR ————————————————— */

  tool({
    name: 'github_issues',
    description: '列出某个仓库的 issue（可选只列指派给我的）。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态' },
        per_page: { type: 'number', description: '条数，默认 20' },
        mine: { type: 'boolean', description: '只看指派给我的' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    async execute({ repo, state = 'open', per_page = 20, mine = false }) {
      const n = Math.min(Math.max(Number(per_page) || 20, 1), 100)
      const list = await gh(`/repos/${repo}/issues?state=${state}&per_page=${n}`)
      const me = mine ? (await gh('/user')).login : ''
      const filtered = me ? list.filter((i) => (i.assignees || []).some((a) => a.login === me)) : list
      return { ok: true, count: filtered.length, issues: filtered.map(slimIssue) }
    },
  })

  tool({
    name: 'github_issue_create',
    description: '新建 issue。写操作：会真的发到仓库里。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签名列表' },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
    async execute({ repo, title, body = '', labels }) {
      const i = await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels } })
      return { ok: true, number: i.number, html_url: i.html_url }
    },
  })

  tool({
    name: 'github_pulls',
    description: '列出仓库的 PR。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态' },
        per_page: { type: 'number', description: '条数，默认 20' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    async execute({ repo, state = 'open', per_page = 20 }) {
      const n = Math.min(Math.max(Number(per_page) || 20, 1), 100)
      const list = await gh(`/repos/${repo}/pulls?state=${state}&per_page=${n}`)
      return { ok: true, count: list.length, pulls: list.map(slimPR) }
    },
  })

  /* ————————————————— 通知 / Actions / Star ————————————————— */

  tool({
    name: 'github_notifications',
    description: '列出 GitHub 未读通知（@我、参与、关注仓库的动态）。',
    parameters: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true = 包含已读' },
        per_page: { type: 'number', description: '条数，默认 30' },
      },
      additionalProperties: false,
    },
    async execute({ all = false, per_page = 30 }) {
      const n = Math.min(Math.max(Number(per_page) || 30, 1), 100)
      const list = await gh(`/notifications?all=${all ? 'true' : 'false'}&per_page=${n}`)
      return {
        ok: true, count: list.length,
        items: list.map((x) => ({
          id: x.id, reason: x.reason, unread: x.unread, updated_at: x.updated_at,
          repo: x.repository?.full_name, title: x.subject?.title, type: x.subject?.type, url: x.subject?.url,
        })),
      }
    },
  })

  tool({
    name: 'github_actions',
    description: '查看仓库最近的 GitHub Actions 运行记录（成功/失败）。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        per_page: { type: 'number', description: '条数，默认 10' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    async execute({ repo, per_page = 10 }) {
      const n = Math.min(Math.max(Number(per_page) || 10, 1), 50)
      const r = await gh(`/repos/${repo}/actions/runs?per_page=${n}`)
      return {
        ok: true, total: r.total_count,
        runs: (r.workflow_runs || []).map((w) => ({
          name: w.name, branch: w.head_branch, status: w.status, conclusion: w.conclusion,
          created_at: w.created_at, html_url: w.html_url,
        })),
      }
    },
  })

  tool({
    name: 'github_star',
    description: '给仓库点 star（或取消）。',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        star: { type: 'boolean', description: 'true 点星，false 取消' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    async execute({ repo, star = true }) {
      await gh(`/user/starred/${repo}`, { method: star ? 'PUT' : 'DELETE' })
      return { ok: true, repo, starred: !!star }
    },
  })
}

export { gh as __gh }

