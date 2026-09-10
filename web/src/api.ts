// ============================================================
// DCP 评审中心 — 共享 API 层 v2
// 每次请求动态获取 teamUUID / appID，不缓存到模块变量
// ============================================================

// ---- 工具 ----

function getHeader(headers: any, key: string): string {
  if (!headers) return ''
  return headers[key] || headers[key.toLowerCase()] || headers[key.toUpperCase()] || ''
}

function extractFromUrls(sources: string[]): { team?: string; app?: string } {
  for (const value of sources) {
    if (!value) continue
    const m = value.match(/\/plugin\/([^/]+)\/([^/]+)\/([^/]+)\//)
    if (m) return { team: m[2], app: m[3] }
  }
  return {}
}

// ---- teamUUID 获取（每次请求动态调用） ----

export function getTeamUUID(): string {
  // 1. ONES 微前端请求头（最高优先级）
  try {
    const env = (window as any).__ONES_MF_ENV__
    if (env?.request?.headers) {
      const h = getHeader(env.request.headers, 'Ones-Check-Id')
      if (h) return h
    }
  } catch { /* next */ }

  // 2. __ONES_MF_ENV__ 直接字段
  try {
    const env = (window as any).__ONES_MF_ENV__ || {}
    if (env.teamUUID) return env.teamUUID
    if (env.team_uuid) return env.team_uuid
    if (env.contextStore?.teamInfo?.uuid) return env.contextStore.teamInfo.uuid
  } catch { /* next */ }

  // 3. @ones-op/store contextStore
  try {
    const store = (window as any).__ONES_STORE__
    const uuid = store?.getState?.()?.contextStore?.teamInfo?.uuid
    if (uuid) return uuid
  } catch { /* next */ }

  // 4. 插件资源路径（URL / scripts）
  {
    const urls: string[] = []
    try { urls.push(window.location.href) } catch {}
    try { urls.push(window.location.pathname) } catch {}
    try {
      for (let i = 0; i < document.scripts.length; i++) {
        urls.push(document.scripts[i].src || '')
      }
    } catch {}
    const r = extractFromUrls(urls)
    if (r.team) return r.team
  }

  // 5. 父窗口 hash
  try {
    const m = window.parent.location.hash.match(/\/team\/([A-Za-z0-9]+)/)
    if (m?.[1]) return m[1]
  } catch { /* cross-origin */ }

  return ''
}

// ---- appID 获取（每次请求动态调用） ----

export function getAppID(): string {
  // 1. __ONES_MF_ENV__
  try {
    const env = (window as any).__ONES_MF_ENV__ || {}
    if (env.pluginID) return env.pluginID
    if (env.appID) return env.appID
  } catch { /* next */ }

  // 2. 插件资源路径
  {
    const urls: string[] = []
    try { urls.push(window.location.href) } catch {}
    try { urls.push(window.location.pathname) } catch {}
    try {
      for (let i = 0; i < document.scripts.length; i++) {
        urls.push(document.scripts[i].src || '')
      }
    } catch {}
    const r = extractFromUrls(urls)
    if (r.app) return r.app
  }

  return 'dev_709xehle'
}

// tools/getAppID() 返回的是文件路径中的 app_id（含 dev_ 前缀），
// 但 ONES API 路由注册时使用的是无前缀的原始 app_id。
function getApiAppID(): string {
  const raw = getAppID()
  return raw.startsWith('dev_') ? raw.slice(4) : raw
}

// ---- instanceId 获取（用于权限检查） ----

let _instanceId = ''
let _orgUuid = ''

function getInstanceId(): string {
  if (_instanceId) return _instanceId
  // 1. __ONES_MF_ENV__
  try {
    const env = (window as any).__ONES_MF_ENV__ || {}
    if (env.instanceId) { _instanceId = env.instanceId; return _instanceId }
    if (env.instance_id) { _instanceId = env.instance_id; return _instanceId }
  } catch { /* ignore */ }
  // 2. 异步获取不到，返回空，由 fetchRealInstanceId 填充
  return ''
}

let _instanceIdPromise: Promise<string> | null = null

async function fetchRealInstanceId(): Promise<string> {
  if (_instanceId) return _instanceId
  if (_instanceIdPromise) return _instanceIdPromise
  _instanceIdPromise = (async () => {
    // plugin/list 端点不返回 mode:org + ProjectCustomComponent 插件
    // 实例 ID 在插件安装后固定不变，从已知映射获取
    const appId = getApiAppID()
    // 已知映射：app_id 709xehle ↔ instance_id gieJW9p2
    const KNOWN_INSTANCES: Record<string, string> = {
      '709xehle': 'gieJW9p2',
    }
    if (KNOWN_INSTANCES[appId]) {
      _instanceId = KNOWN_INSTANCES[appId]
      return _instanceId
    }
    // 兜底：尝试 plugin/list（大概率失败）
    const tu = getTeamUUID()
    const ou = getOrgUUID()
    if (!tu) return appId
    try {
      const res = await fetch(
        `/project/api/project/team/${tu}/plugin/list`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization_uuid: ou, team_uuid: tu }),
        }
      )
      const j = await res.json()
      const list = j?.data
      if (Array.isArray(list)) {
        const devAppId = 'dev_' + appId
        for (const item of list) {
          const svc = item?.service
          if (svc && (svc.app_id === appId || svc.app_id === devAppId)) {
            _instanceId = svc.instance_id || ''
            return _instanceId
          }
        }
      }
    } catch { /* ignore */ }
    return appId
  })()
  return _instanceIdPromise
}

function getOrgUUID(): string {
  if (_orgUuid) return _orgUuid
  // 1. __ONES_MF_ENV__
  try {
    const env = (window as any).__ONES_MF_ENV__ || {}
    if (env.organizationUUID) { _orgUuid = env.organizationUUID; return _orgUuid }
    if (env.organization_uuid) { _orgUuid = env.organization_uuid; return _orgUuid }
  } catch { /* ignore */ }
  // 2. 父窗口 hash（ONES 页面 URL 格式：#/plugin/{org}/{team}/{app}/...）
  try {
    const hash = window.parent.location.hash
    const m = hash.match(/\/plugin\/([^/]+)\/([^/]+)\/([^/]+)\//)
    if (m) { _orgUuid = m[1]; return _orgUuid }
  } catch { /* cross-origin, ignore */ }
  // 3. 插件脚本路径
  try { for (let i = 0; i < document.scripts.length; i++) {
    const src = document.scripts[i].src || ''
    const m = src.match(/\/plugin\/([^/]+)\/([^/]+)\/([^/]+)\//)
    if (m) { _orgUuid = m[1]; return _orgUuid }
  }} catch {}
  // 4. window.location 兜底
  const sources: string[] = []
  try { sources.push(window.location.href) } catch {}
  try { sources.push(window.location.pathname) } catch {}
  for (const src of sources) {
    const m = src.match(/\/plugin\/([^/]+)\/([^/]+)\/([^/]+)\//)
    if (m) { _orgUuid = m[1]; return _orgUuid }
  }
  // 5. 硬编码已知值 — org UUID 在安装实例中固定不变
  _orgUuid = 'MVUtevnf'
  return _orgUuid
}

// ---- 权限检查 ----

export async function checkPermission(permField: string): Promise<boolean> {
  if (!permField) return true
  const tu = getTeamUUID()
  const ou = getOrgUUID()
  if (!tu) return false
  try {
    const iid = await fetchRealInstanceId()
    // batch_check 端点要求 Ones-Plugin-Id: built_in_apis 请求头
    const res = await fetch(
      `/project/api/project/plugin/permissionrule/batch_check`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Ones-Plugin-Id': 'built_in_apis',
        },
        body: JSON.stringify({
          permission_rules: [{
            organization_uuid: ou,
            team_uuid: tu,
            instance_id: iid,
            permission_field: permField,
            context: {},
          }],
        }),
      }
    )
    if (!res.ok) {
      console.warn(`[DCP] Permission check failed: ${res.status} for ${permField}`)
      return false
    }
    const j = await res.json()
    const results = j?.data
    if (Array.isArray(results) && results.length > 0) {
      return results[0]?.is_permission === true
    }
    return false
  } catch (err) {
    console.warn(`[DCP] Permission check error for ${permField}:`, err)
    return false
  }
}

// ---- API 请求 ----

export class DcpApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'DcpApiError'
    this.status = status
  }
}

async function readApiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text)
    const payload = json.body || json.data || json
    if (payload?.error) return payload.error
  } catch { /* 非 JSON 响应使用状态码 */ }
  if (res.status === 401) return '登录状态已失效，请重新登录后再试。'
  if (res.status === 403) return '没有执行此操作的权限。'
  if (res.status === 503) return '权限服务暂时不可用，请稍后重试。'
  return text.substring(0, 500) || `HTTP ${res.status}`
}

function buildUrl(endpoint: string): string {
  const tu = getTeamUUID()
  if (!tu) {
    throw new DcpApiError(
      '未获取到团队 UUID，请从 ONES 插件入口重新进入页面。',
      0
    )
  }
  // 分离已有 query string
  const [path, qs] = endpoint.split('?')
  return `/project/api/project/team/${tu}${path}?team_uuid=${tu}${qs ? '&' + qs : ''}`
}

export async function apiGet(endpoint: string): Promise<any> {
  const url = buildUrl(endpoint)
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Ones-Plugin-Id': getApiAppID() },
  })
  if (!res.ok) {
    throw new DcpApiError(await readApiError(res), res.status)
  }
  const json = await res.json()
  // external API 响应包裹在 data 中，backend 返回包裹在 body 中
  return json.body || json.data || json
}

export async function apiPost(endpoint: string, body: any): Promise<any> {
  const url = buildUrl(endpoint)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Ones-Plugin-Id': getApiAppID() },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new DcpApiError(await readApiError(res), res.status)
  }
  const json = await res.json()
  // external API 响应包裹在 data 中，backend 返回包裹在 body 中
  return json.body || json.data || json
}

export async function apiDelete(endpoint: string): Promise<any> {
  const url = buildUrl(endpoint)
  const res = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Ones-Plugin-Id': getApiAppID() },
  })
  if (!res.ok) {
    throw new DcpApiError(await readApiError(res), res.status)
  }
  const json = await res.json()
  return json.body || json.data || json
}

// ---- Reviewer Profile / Project Binding ----
export const upsertProjectBinding = (data: { project_uuid: string; profile_id: string; review_type: string }) =>
  apiPost('/dcp/project-binding', data)

export const deleteProjectBinding = (bindingId: string) =>
  apiDelete(`/dcp/project-binding/${bindingId}`)
