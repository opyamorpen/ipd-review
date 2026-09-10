// ============================================================
// DCP 评审中心 v1.6.5 — Backend
//
// Changelog since v1.6.4:
// - Fixed "新建工作项" redirect: use parent window projectUuid instead of stored value
// - Fixed reviewer-workspace exchange API path for project UUID resolution
// ============================================================
import { Logger } from '@ones-op/node-logger'
import { env, storage } from '@ones-op/sdk/node'
import { PluginResponse } from '@ones-op/node-types'
import { OPFetch, getOpenApiToken } from '@ones-op/fetch'
import { Notify, NotifyWay } from '@ones-op/node-ability'

// ============================================================
// 实体引用
// ============================================================
const baseCfg = storage.entity('dcp_base_config')
const phaseTpl = storage.entity('dcp_phase_template')
const matTpl = storage.entity('dcp_material_template')
const indTpl = storage.entity('dcp_indicator_template')
const roleTpl = storage.entity('dcp_reviewer_role')
const review = storage.entity('dcp_review')
const matItem = storage.entity('dcp_review_material')
const indData = storage.entity('dcp_review_indicator')
const rvReviewer = storage.entity('dcp_review_reviewer')
const linkedIssue = storage.entity('dcp_linked_issue')
const resolution = storage.entity('dcp_resolution')
const supplement = storage.entity('dcp_supplement')
const auditLog = storage.entity('dcp_audit_log')
const checkItem = storage.entity('dcp_checklist_item')
const checkResult = storage.entity('dcp_checklist_result')
const reviewerProfile = storage.entity('dcp_reviewer_profile')
const projectBinding = storage.entity('dcp_project_binding')
const phaseGuard = storage.entity('dcp_phase_guard')

const ALL_ENTITIES = [matItem, indData, rvReviewer, linkedIssue, resolution, supplement, auditLog, phaseGuard]

// ============================================================
// 工具
// ============================================================
async function qAll(e: any, filter?: (v: any) => boolean) {
  const allItems: any[] = []
  let cursor: string | null = null
  let safety = 0
  while (safety < 100) {
    safety++
    const q = e.query().limit(200)
    if (cursor) q.cursor(cursor)
    const result = await q.getMany()
    if (!result || !Array.isArray(result.data)) break
    for (const d of result.data) {
      allItems.push({ _key: d.key, ...(d.value || {}) })
    }
    const pi = result.page_info
    if (pi && pi.has_more && pi.end_cursor) {
      cursor = pi.end_cursor
    } else {
      break
    }
  }
  return filter ? allItems.filter((d: any) => filter(d)) : allItems
}

async function writeAudit(rvUuid: string, op: string, action: string, target: string, detail: string, result = 'success') {
  const k = `${rvUuid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  await auditLog.set(k, {
    review_uuid: rvUuid, timestamp: Date.now(), operator_uuid: op || '',
    action, target, detail, result,
  })
}

function jsonArr(s: string): any[] {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : [] } catch { return [] }
}

// 清理实体写入对象：ONES KV 存储不允许 null/undefined 值，写入前必须过滤
function cleanForSet(obj: any): any {
  const out: any = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k !== '_key' && v !== null && v !== undefined) out[k] = v
  }
  return out
}

// ONES SDK occasionally throws plain objects whose useful fields are non-enumerable.
// Preserve those fields so API errors remain actionable instead of becoming "[object Object]".
function formatError(error: any): string {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const own = Object.getOwnPropertyNames(error)
    try {
      const serialized = JSON.stringify(error, own)
      if (serialized && serialized !== '{}') return serialized
    } catch { /* fall through to message */ }
    return error.message || String(error)
  }
  if (typeof error === 'object') {
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== '{}') return serialized
    } catch { /* fall through to String */ }
  }
  return String(error)
}

function makeUuid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// 获取当前轮次的最新决议（多轮复审时只取当前轮次，多条时取 published_at 最大）
function getLatestResolution(resolutions: any[], roundNo: number): any | null {
  const current = resolutions.filter((r: any) => (r.round_no || 1) === roundNo)
  if (current.length === 0) return null
  current.sort((a: any, b: any) => (b.published_at || 0) - (a.published_at || 0))
  return current[0]
}

const ACTIVE_PHASE_STATES = new Set([
  'draft', 'ready', 'reviewing', 'awaiting_resolution',
  'resolution_published', 'remediation_pending', 're_reviewing',
])

type CanonicalProjectIdentity = {
  canonicalUuid: string
  identifier: string
  key: string
  lookupIds: Set<string>
}

type PhaseDependencySnapshot = {
  canonicalProjectUuid: string
  projectIdentifier: string
  dependencies: string[]
  capturedAt: number
}

type EvidenceEditContext = {
  editable: boolean
  frozen: boolean
  targetRound: number
  state: string
}

function normalizeReviewType(value: any): string {
  return value === 'tr' ? 'tr' : 'dcp'
}

function phaseGuardKey(projectUuid: string, phaseCode: string, reviewType: string): string {
  const raw = `${projectUuid}|${phaseCode}|${normalizeReviewType(reviewType)}`
  let hash = 2166136261
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `phase_${(hash >>> 0).toString(36)}`
}

async function findPhaseReviewConflict(
  projectIds: Set<string>, phaseCode: string, reviewType: string, excludeReviewUuid = '',
): Promise<{ kind: 'active' | 'passed'; review: any; resolution: any | null } | null> {
  const candidates = await qAll(review, (v: any) =>
    projectIds.has(String(v.project_uuid || '')) &&
    v.phase_code === phaseCode &&
    normalizeReviewType(v.review_type) === normalizeReviewType(reviewType) &&
    v.review_uuid !== excludeReviewUuid,
  )
  let activeConflict: { kind: 'active'; review: any; resolution: any | null } | null = null
  for (const candidate of candidates) {
    const state = getEffectiveState(candidate)
    const resolutions = await qAll(resolution, (v: any) => v.review_uuid === candidate.review_uuid)
    const latest = getLatestResolution(resolutions, Number(candidate.round_no || 1))
    if (ACTIVE_PHASE_STATES.has(state) && !activeConflict) {
      activeConflict = { kind: 'active', review: candidate, resolution: latest }
    }
    if ((state === 'completed' || state === 'archived') &&
      (latest?.final_conclusion === 'pass' || latest?.final_conclusion === 'conditional_pass')) {
      return { kind: 'passed', review: candidate, resolution: latest }
    }
  }
  return activeConflict
}

function phaseConflictResponse(conflict: { kind: 'active' | 'passed'; review: any }, phaseName: string, reviewType: string): PluginResponse {
  const conflictState = getEffectiveState(conflict.review)
  const code = conflict.kind === 'passed' ? 'REVIEW_PHASE_ALREADY_PASSED' : 'REVIEW_PHASE_ALREADY_ACTIVE'
  const message = conflict.kind === 'passed'
    ? `${reviewType === 'tr' ? 'TR' : 'DCP'}阶段「${phaseName}」已通过评审，不可重复发起`
    : `${reviewType === 'tr' ? 'TR' : 'DCP'}阶段「${phaseName}」已有评审单处于${conflictState}，请继续原评审单`
  return {
    body: {
      code,
      error: message,
      conflict_review_uuid: conflict.review.review_uuid || '',
      conflict_review_number: conflict.review.review_number || '',
      conflict_review_status: conflictState,
    },
    statusCode: 409,
  }
}

async function claimPhaseGuard(
  projectUuid: string, phaseCode: string, reviewType: string, reviewUuid: string,
): Promise<{ ok: boolean; existing?: any }> {
  const key = phaseGuardKey(projectUuid, phaseCode, reviewType)
  const now = Date.now()
  let existing: any = null
  try { existing = await phaseGuard.get(key) as any } catch { existing = null }
  if (existing?.guard_state === 'active' && existing.review_uuid && existing.review_uuid !== reviewUuid) {
    const existingReview = await review.get(existing.review_uuid)
    if (existingReview) {
      const conflict = await findPhaseReviewConflict(new Set([projectUuid]), phaseCode, reviewType, reviewUuid)
      if (conflict) return { ok: false, existing: existingReview }
    }
  }
  await phaseGuard.set(key, {
    guard_key: key,
    project_uuid: projectUuid,
    phase_code: phaseCode,
    review_type: normalizeReviewType(reviewType),
    review_uuid: reviewUuid,
    guard_state: 'active',
    claimed_at: now,
    released_at: 0,
  })
  const confirmed = await phaseGuard.get(key) as any
  if (confirmed?.review_uuid !== reviewUuid || confirmed?.guard_state !== 'active') {
    return { ok: false, existing: confirmed }
  }
  return { ok: true }
}

async function releasePhaseGuard(rv: any): Promise<void> {
  const projectUuid = String(rv?.project_uuid || '')
  const phaseCode = String(rv?.phase_code || '')
  if (!projectUuid || !phaseCode) return
  const key = phaseGuardKey(projectUuid, phaseCode, normalizeReviewType(rv?.review_type))
  try {
    const current = await phaseGuard.get(key) as any
    if (current?.review_uuid === rv.review_uuid) {
      await phaseGuard.set(key, { ...current, guard_state: 'released', released_at: Date.now() })
    }
  } catch { /* guard release must not block the business operation */ }
}

function getEvidenceEditContext(rv: any): EvidenceEditContext {
  const state = getEffectiveState(rv)
  const currentRound = Number(rv?.round_no || 1)
  const editable = state === 'draft' || state === 'ready' || state === 'remediation_pending'
  return {
    editable,
    frozen: !editable,
    targetRound: state === 'remediation_pending' ? currentRound + 1 : currentRound,
    state,
  }
}

function evidenceEditDenied(context: EvidenceEditContext): PluginResponse | null {
  if (context.editable) return null
  return {
    body: {
      code: 'REVIEW_EVIDENCE_FROZEN',
      error: '当前评审状态下投票依据已冻结，不可修改',
      review_state: context.state,
    },
    statusCode: 403,
  }
}

// ---- 通知 ---- 

const NOTIFY_WAY_MAP: Record<string, NotifyWay> = {
  email: NotifyWay.Email,
  wechat: NotifyWay.WeChat,
  dingtalk: NotifyWay.DingDing,
  feishu: NotifyWay.Lark,
  youdao: NotifyWay.YouDu,
}

async function getNotifyConfig(): Promise<any> {
  try {
    const cfg = await baseCfg.get('notify_config')
    if (cfg && (cfg as any).value) return JSON.parse((cfg as any).value)
  } catch { /* ignore */ }
  // 默认配置
  return {
    enabled: true,
    on_review_start: true,
    on_all_submitted: true,
    on_resolution: true,
    channels: { email: true, wechat: false, dingtalk: false, feishu: false, youdao: false },
  }
}

// 评审撤回配置
async function getReviewRecallConfig(): Promise<any> {
  try {
    const cfg = await baseCfg.get('review_recall_config')
    if (cfg && (cfg as any).value) return JSON.parse((cfg as any).value)
  } catch { /* ignore */ }
  return {
    enabled: false,
    allowedBeforeResolution: true,
    requireReason: true,
    clearSubmittedOpinions: true,
  }
}

async function sendNotification(
  title: string, body: string, url: string, toUsers: string[], channels?: Record<string, boolean>
): Promise<{ attempted: string[]; succeeded: string[]; failed: { channel: string; error: string }[] }> {
  const cfg = await getNotifyConfig()
  const result = { attempted: [] as string[], succeeded: [] as string[], failed: [] as { channel: string; error: string }[] }
  if (!cfg.enabled) return result
  const ch = channels || cfg.channels
  for (const [key, enabled] of Object.entries(ch)) {
    if (!enabled) continue
    const way = NOTIFY_WAY_MAP[key]
    if (!way) continue
    result.attempted.push(key)
    try {
      await Notify({
        Title: title,
        ToUsers: toUsers,
        NotifyWay: way,
        MessageBody: [{ Body: body, Url: url }],
      })
      result.succeeded.push(key)
      Logger.info(`[DCP] Notification sent: ${key} to ${toUsers.length} users`)
    } catch (e: any) {
      const errMsg = e?.message || e?.msg || (typeof e === 'string' ? e : JSON.stringify(e))
      result.failed.push({ channel: key, error: errMsg })
      Logger.error(`[DCP] Notification failed (${key}):`, errMsg)
    }
  }
  return result
}

// external API 兼容：路径参数可能在 req.params 或需从 URL 中提取
function getParam(req: any, name: string): string {
  if (req.params?.[name]) return req.params[name]
  // query string 参数（如 ?review_type=dcp）—— ONES external API 不提供 req.query，手动解析
  if (req.query?.[name] !== undefined) return String(req.query[name])
  const rawUrl = req.url || req.path || ''
  const qIdx = rawUrl.indexOf('?')
  if (qIdx >= 0) {
    const qs = rawUrl.slice(qIdx + 1)
    for (const pair of qs.split('&')) {
      const eq = pair.indexOf('=')
      const k = eq >= 0 ? pair.slice(0, eq) : pair
      const v = eq >= 0 ? pair.slice(eq + 1) : ''
      if (decodeURIComponent(k) === name) return decodeURIComponent(v)
    }
  }
  // 去掉 query string，防止正则把 ?xxx 也匹配进去
  const url = rawUrl.split('?')[0]
  // 匹配 /{name}/{value}（如 /review_uuid/xxx）
  const named = url.match(new RegExp(`/${name}/([^/]+)`))
  if (named) return named[1]
  // review_uuid 出现在 /dcp/review/{uuid} 或 /dcp/review/{uuid}/子路径
  if (name === 'review_uuid') {
    const rv = url.match(/\/dcp\/review\/([^/]+)/)
    if (rv) return rv[1]
  }
  // project_uuid 出现在 /by-project/{uuid}
  if (name === 'project_uuid') {
    const pj = url.match(new RegExp('/by-project/([^/]+)'))
    if (pj) return pj[1]
  }
  // template_id 出现在 /material/{value}/file
  if (name === 'template_id') {
    const tid = url.match(new RegExp('/material/([^/]+)'))
    if (tid) return tid[1]
  }
  // team_uuid 出现在 /team/{uuid}
  if (name === 'team_uuid') {
    const tm = url.match(/\/team\/([^/]+)/)
    if (tm) return tm[1]
  }
  // review_type 只从 params/query 取，不走路径兜底（否则会误匹配 URL 末尾段）
  if (name === 'review_type') return ''
  // 最后一个兜底：匹配路径末尾段（如 /dcp/review/{value} 无子路径时）
  const last = url.match(/\/([^/]+)\/?$/)
  if (last && last[1] !== name) return last[1]
  return ''
}

function getQueryParam(req: any, name: string): string {
  if (req.query?.[name] !== undefined) return String(req.query[name])
  const rawUrl = req.url || req.path || ''
  const qIdx = rawUrl.indexOf('?')
  if (qIdx < 0) return ''
  for (const pair of rawUrl.slice(qIdx + 1).split('&')) {
    const eq = pair.indexOf('=')
    const key = eq >= 0 ? pair.slice(0, eq) : pair
    if (decodeURIComponent(key) !== name) continue
    return decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : '')
  }
  return ''
}

// 获取当前请求的真实用户 UUID（方案A：不信任前端 body 传递的身份）
// ONES 网关在用户通过页面访问插件接口时自动注入 Ones-User-Id 请求头
function getOperator(req: any): string {
  if (!req?.headers) return ''
  const h = req.headers
  // ONES 注入的请求头大小写不确定，全量兼容
  const raw = h['ones-user-id'] || h['Ones-User-Id'] || h['ONES-USER-ID'] || ''
  return Array.isArray(raw) ? String(raw[0] || '').trim() : String(raw).trim()
}

type PluginPermission = 'dcp_admin' | 'dcp_create_review' | 'dcp_view_review'
type ApiPolicy =
  | 'identity'
  | 'admin'
  | 'create'
  | 'overview'
  | 'self'
  | 'project-read'
  | 'review-read'
  | 'review-creator'
  | 'review-create-creator'
  | 'review-contributor'
  | 'review-participant'
  | 'review-publisher'
  | 'review-creator-or-publisher'

type ApiHandler = (req: any) => Promise<PluginResponse>

interface RequestAuthorizationCache {
  permissions: Map<PluginPermission, boolean>
  projectAccess: Map<string, boolean>
}

class AuthorizationServiceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AuthorizationServiceError'
    this.code = code
  }
}

const authorizationCache = new WeakMap<object, RequestAuthorizationCache>()

function getAuthorizationCache(req: any): RequestAuthorizationCache {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return { permissions: new Map(), projectAccess: new Map() }
  }
  let cached = authorizationCache.get(req)
  if (!cached) {
    cached = { permissions: new Map(), projectAccess: new Map() }
    authorizationCache.set(req, cached)
  }
  return cached
}

function getRequestHeader(req: any, name: string): string {
  const headers = req?.headers || {}
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    return Array.isArray(value) ? String(value[0] || '') : String(value || '')
  }
  return ''
}

function getForwardedAuthenticationHeaders(req: any): Record<string, string> {
  const headers: Record<string, string> = {}
  const authToken = getRequestHeader(req, 'Ones-Auth-Token')
  const cookie = getRequestHeader(req, 'Cookie')
  if (authToken) headers['Ones-Auth-Token'] = authToken
  if (cookie) headers.Cookie = cookie
  if (!authToken && !cookie) {
    throw new AuthorizationServiceError('AUTHENTICATION_CONTEXT_MISSING', '请求未携带可验证的 ONES 登录凭证')
  }
  return headers
}

function getTrustedRequestOrigin(req: any): string {
  const forwardedHost = getRequestHeader(req, 'X-Forwarded-Host').split(',')[0].trim()
  const forwardedProto = getRequestHeader(req, 'X-Forwarded-Proto').split(',')[0].trim().toLowerCase()
  if (!forwardedHost || !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(forwardedHost)) return ''
  if (forwardedProto !== 'https' && forwardedProto !== 'http') return ''
  return `${forwardedProto}://${forwardedHost}`
}

function authResponse(statusCode: 401 | 403 | 503, code: string, error: string): PluginResponse {
  return { body: { code, error }, statusCode }
}

function logAuthorizationDenied(req: any, code: string, policy: ApiPolicy, detail = ''): void {
  const path = String(req?.url || req?.path || '').split('?')[0].slice(0, 200)
  const operator = getOperator(req) || 'anonymous'
  const teamUUID = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || ''
  Logger.info(`[DCP][AUTHZ_DENY] code=${code}, policy=${policy}, operator=${operator}, team=${teamUUID}, path=${path}${detail ? `, detail=${detail}` : ''}`)
}

async function getAuthorizationRuntime(req: any): Promise<{
  teamUUID: string
  organizationUUID: string
  instanceId: string
  platformApiHost: string
}> {
  const routeTeamUUID = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || ''
  const [runtimeTeamUUID, organizationUUID, instanceId, platformApiHost] = await Promise.all([
    env.getTeamUUID(),
    env.getOrganizationUUID(),
    env.getInstanceId(),
    env.getPlatformAPIHost(),
  ])
  const teamUUID = routeTeamUUID || runtimeTeamUUID
  if (!teamUUID || !organizationUUID || !instanceId || !platformApiHost) {
    throw new AuthorizationServiceError('AUTHORIZATION_CONTEXT_INCOMPLETE', 'ONES 授权上下文不完整')
  }
  if (routeTeamUUID && runtimeTeamUUID && routeTeamUUID !== runtimeTeamUUID) {
    throw new AuthorizationServiceError('AUTHORIZATION_TEAM_MISMATCH', '请求团队与运行时团队不一致')
  }
  return { teamUUID, organizationUUID, instanceId, platformApiHost }
}

function buildPlatformUrl(platformApiHost: string, path: string): string {
  try {
    return new URL(path, platformApiHost).toString()
  } catch {
    throw new AuthorizationServiceError('AUTHORIZATION_CONTEXT_INVALID', 'ONES 平台地址无效')
  }
}

function authorizationRequestErrorCode(prefix: string, error: any): string {
  const detail = error?.response?.status || error?.status || error?.code || 'UNKNOWN'
  return `${prefix}_${String(detail).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`
}

function parsePermissionResult(response: any): boolean {
  const payload = response?.data ?? response
  const results = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.body?.data)
      ? payload.body.data
      : Array.isArray(payload)
        ? payload
        : null
  if (!results || results.length === 0 || typeof results[0]?.is_permission !== 'boolean') {
    throw new AuthorizationServiceError('AUTHORIZATION_RESPONSE_INVALID', 'ONES 权限服务返回格式无效')
  }
  return results[0].is_permission === true
}

async function hasPluginPermission(req: any, permission: PluginPermission): Promise<boolean> {
  const cache = getAuthorizationCache(req)
  const cached = cache.permissions.get(permission)
  if (cached !== undefined) return cached

  const { teamUUID, organizationUUID, instanceId, platformApiHost } = await getAuthorizationRuntime(req)
  const requestOrigin = getTrustedRequestOrigin(req) || platformApiHost
  const authenticationHeaders = getForwardedAuthenticationHeaders(req)
  try {
    const response = await OPFetch(buildPlatformUrl(requestOrigin, '/project/api/project/plugin/permissionrule/batch_check'), {
      method: 'POST',
      headers: {
        ...authenticationHeaders,
        'Content-Type': 'application/json',
        'Ones-Plugin-Id': 'built_in_apis',
      },
      data: {
        permission_rules: [{
          organization_uuid: organizationUUID,
          team_uuid: teamUUID,
          instance_id: instanceId,
          permission_field: permission,
          context: {},
        }],
      },
    } as any)
    const allowed = parsePermissionResult(response)
    cache.permissions.set(permission, allowed)
    return allowed
  } catch (error: any) {
    if (error instanceof AuthorizationServiceError) throw error
    throw new AuthorizationServiceError(
      authorizationRequestErrorCode('AUTHORIZATION_REQUEST_FAILED', error),
      `ONES 权限服务不可用: ${error?.message || String(error)}`,
    )
  }
}

async function getReviewParticipants(rv: any): Promise<any[]> {
  const rid = String((rv as any)?.review_uuid || '')
  if (!rid) return []
  const rows = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  return rows.length > 0 ? rows : jsonArr((rv as any).reviewers_json || '[]')
}

async function isReviewParticipant(rv: any, operator: string): Promise<boolean> {
  if (!operator) return false
  const participants = await getReviewParticipants(rv)
  return participants.some((item: any) => item.reviewer_uuid === operator)
}

async function canAccessProject(req: any, projectKey: string): Promise<boolean> {
  if (!projectKey) return false
  const cache = getAuthorizationCache(req)
  const cached = cache.projectAccess.get(projectKey)
  if (cached !== undefined) return cached

  const { teamUUID, platformApiHost } = await getAuthorizationRuntime(req)
  const requestOrigin = getTrustedRequestOrigin(req) || platformApiHost
  const authenticationHeaders = getForwardedAuthenticationHeaders(req)
  try {
    const meta = await resolveProjectMeta(teamUUID, projectKey)
    const project = await findProjectByGraphQL(
      teamUUID,
      meta.project_real_uuid || projectKey,
      meta.project_identifier || projectKey,
      false,
      authenticationHeaders,
      requestOrigin,
    )
    const allowed = !!project
    cache.projectAccess.set(projectKey, allowed)
    return allowed
  } catch (error: any) {
    throw new AuthorizationServiceError(
      authorizationRequestErrorCode('PROJECT_AUTHORIZATION_REQUEST_FAILED', error),
      `ONES 项目权限校验不可用: ${error?.message || String(error)}`,
    )
  }
}

async function canReadReview(req: any, rv: any, operator: string): Promise<boolean> {
  if ((rv as any).creator_uuid === operator || await isReviewParticipant(rv, operator)) return true

  let dependencyError: AuthorizationServiceError | null = null
  try {
    if (await canAccessProject(req, String((rv as any).project_uuid || ''))) return true
  } catch (error: any) {
    dependencyError = error instanceof AuthorizationServiceError
      ? error
      : new AuthorizationServiceError('PROJECT_AUTHORIZATION_REQUEST_FAILED', String(error))
  }

  try {
    if (await hasPluginPermission(req, 'dcp_view_review')) return true
  } catch (error: any) {
    dependencyError = error instanceof AuthorizationServiceError
      ? error
      : new AuthorizationServiceError('AUTHORIZATION_REQUEST_FAILED', String(error))
  }

  if (dependencyError) throw dependencyError
  return false
}

async function authorizeApiRequest(req: any, policy: ApiPolicy): Promise<PluginResponse | null> {
  const operator = getOperator(req)
  if (!operator) {
    logAuthorizationDenied(req, 'AUTHENTICATION_REQUIRED', policy)
    return authResponse(401, 'AUTHENTICATION_REQUIRED', '无法确认当前登录用户身份')
  }

  try {
    if (policy === 'identity' || policy === 'self') return null

    const permissionByPolicy: Partial<Record<ApiPolicy, PluginPermission>> = {
      admin: 'dcp_admin',
      create: 'dcp_create_review',
      overview: 'dcp_view_review',
    }
    const requiredPermission = permissionByPolicy[policy]
    if (requiredPermission) {
      if (await hasPluginPermission(req, requiredPermission)) return null
      logAuthorizationDenied(req, 'PERMISSION_DENIED', policy, requiredPermission)
      return authResponse(403, 'PERMISSION_DENIED', '没有执行此操作的权限')
    }

    if (policy === 'project-read') {
      const projectUUID = getParam(req, 'project_uuid')
      if (projectUUID && await canAccessProject(req, projectUUID)) return null
      logAuthorizationDenied(req, 'PROJECT_ACCESS_DENIED', policy)
      return authResponse(403, 'PROJECT_ACCESS_DENIED', '没有访问该项目的权限')
    }

    const reviewUUID = getParam(req, 'review_uuid')
    if (!reviewUUID) return { body: { code: 'INVALID_REQUEST', error: '缺少 review_uuid' }, statusCode: 400 }
    const rv = await review.get(reviewUUID)
    if (!rv) return { body: { code: 'REVIEW_NOT_FOUND', error: '评审单不存在' }, statusCode: 404 }

    let allowed = false
    if (policy === 'review-read') {
      allowed = await canReadReview(req, rv, operator)
    } else if (policy === 'review-creator' || policy === 'review-create-creator') {
      allowed = (rv as any).creator_uuid === operator
      if (allowed && policy === 'review-create-creator') {
        allowed = await hasPluginPermission(req, 'dcp_create_review')
      }
    } else if (policy === 'review-contributor' || policy === 'review-participant') {
      allowed = await isReviewParticipant(rv, operator)
      if (policy === 'review-contributor') allowed = allowed || (rv as any).creator_uuid === operator
    } else if (policy === 'review-publisher') {
      allowed = await isPublisherRole(rv, operator)
    } else if (policy === 'review-creator-or-publisher') {
      allowed = (rv as any).creator_uuid === operator || await isPublisherRole(rv, operator)
    }

    if (allowed) return null
    logAuthorizationDenied(req, 'REVIEW_ACCESS_DENIED', policy, `review=${reviewUUID}`)
    return authResponse(403, 'REVIEW_ACCESS_DENIED', '没有访问或操作该评审单的权限')
  } catch (error: any) {
    const message = error?.message || (typeof error === 'object' ? JSON.stringify(error) : String(error))
    Logger.error(`[DCP][AUTHZ_UNAVAILABLE] policy=${policy}, error=${message}`)
    const code = error instanceof AuthorizationServiceError
      ? error.code
      : 'AUTHORIZATION_SERVICE_UNAVAILABLE'
    return authResponse(503, code, '权限服务暂时不可用，请稍后重试')
  }
}

function withAuthorization(policy: ApiPolicy, handler: ApiHandler): ApiHandler {
  return async (req: any): Promise<PluginResponse> => {
    const denied = await authorizeApiRequest(req, policy)
    if (denied) return denied
    return handler(req)
  }
}

// ============================================================
// 生命周期
// ============================================================
export function Install() { Logger.info('[DCP] Install') }
export function Disable() { Logger.info('[DCP] Disable') }
export function UnInstall() { Logger.info('[DCP] UnInstall') }

// ============================================================
// 项目元数据解析（project_uuid → name/identifier/real_uuid）
// ============================================================
async function findProjectByGraphQL(
  teamUUID: string,
  realUUID: string,
  identifier: string,
  root = true,
  requestHeaders: Record<string, string> = {},
  platformApiHost = '',
): Promise<any> {
  const path = `/project/api/project/team/${teamUUID}/items/graphql?t=dcp_project_meta`
  const gqlRes = await OPFetch(
    platformApiHost ? buildPlatformUrl(platformApiHost, path) : path,
    {
      method: 'POST',
      root,
      teamUUID,
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      data: {
        query: `{
          buckets(
            groupBy: { projects: {} },
            pagination: { limit: 100, after: "", preciseCount: true }
          ) {
            projects(
              limit: 10000,
              filterGroup: [
                { visibleInProject_equal: true, isArchive_equal: false }
              ]
            ) {
              uuid
              identifier
              name
              key
            }
          }
        }`,
        variables: {},
      },
    }
  ) as any

  const buckets =
    gqlRes?.data?.data?.buckets ||
    gqlRes?.data?.buckets ||
    gqlRes?.buckets ||
    []

  const projects = buckets.flatMap((bucket: any) => bucket.projects || [])
  return projects.find((p: any) => p.uuid === realUUID || p.identifier === identifier) || null
}

async function findProjectByStamp(
  teamUUID: string,
  realUUID: string,
  requestHeaders: Record<string, string> = {},
  platformApiHost = '',
): Promise<any> {
  const path = `/project/api/project/team/${teamUUID}/project/${realUUID}/stamps/data?t=project`
  const stampRes = await OPFetch(
    platformApiHost ? buildPlatformUrl(platformApiHost, path) : path,
    {
      method: 'POST',
      root: !platformApiHost,
      teamUUID,
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      data: { project: 0 },
    }
  ) as any
  const stampData = stampRes?.data || stampRes
  return stampData?.project?.projects?.[0] || null
}

async function resolveProjectMeta(
  teamUUID: string,
  projectKey: string,
  requestHeaders: Record<string, string> = {},
  platformApiHost = '',
): Promise<Record<string, string>> {
  let identifier = projectKey
  let realUUID = ''

  // Step 1: exchange API → real UUID + identifier（失败不致命）
  try {
    const exchangePath = `/project/api/ones-project/team/${teamUUID}/projects/exchange/${projectKey}`
    const exchRes = await OPFetch(
      platformApiHost ? buildPlatformUrl(platformApiHost, exchangePath) : exchangePath,
      { root: !platformApiHost, teamUUID, headers: requestHeaders }
    )
    const exchData = exchRes?.data || exchRes || {}
    identifier = exchData.identifier || projectKey
    realUUID = exchData.project_uuid || ''
  } catch (err: any) {
    Logger.info(`[DCP][project-meta] exchange failed, key=${projectKey}, err=${err?.message || err}`)
  }

  // Step 2: GraphQL → project name（失败不致命）
  let project: any = null
  if (realUUID || identifier) {
    try {
      project = await findProjectByGraphQL(
        teamUUID, realUUID || projectKey, identifier, !platformApiHost, requestHeaders, platformApiHost,
      )
    } catch (err: any) {
      Logger.info(`[DCP][project-meta] graphql failed, key=${projectKey}, realUUID=${realUUID}, err=${err?.message || err}`)
    }
  }

  // Step 3: stamps 兜底 → project name
  if (!project && realUUID) {
    try {
      project = await findProjectByStamp(teamUUID, realUUID, requestHeaders, platformApiHost)
    } catch (err: any) {
      Logger.info(`[DCP][project-meta] stamp failed, key=${projectKey}, realUUID=${realUUID}, err=${err?.message || err}`)
    }
  }

  return {
    project_identifier: project?.identifier || identifier || projectKey,
    project_real_uuid: project?.uuid || realUUID || '',
    project_key: project?.key || '',
    project_name: project?.name || identifier || projectKey,
  }
}

async function resolveCanonicalProjectIdentity(req: any, projectRef: string): Promise<CanonicalProjectIdentity> {
  const teamUUID = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || await env.getTeamUUID()
  if (!teamUUID || !projectRef) {
    throw new Error('无法确定项目身份')
  }
  const runtime = await getAuthorizationRuntime(req)
  const platformApiHost = getTrustedRequestOrigin(req) || runtime.platformApiHost
  const meta = await resolveProjectMeta(
    teamUUID, projectRef, getForwardedAuthenticationHeaders(req), platformApiHost,
  )
  const canonicalUuid = String(meta.project_real_uuid || '')
  if (!canonicalUuid) {
    throw new Error('无法从 ONES 获取项目真实 UUID，已拒绝执行阶段规则')
  }
  const identifier = String(meta.project_identifier || '')
  const key = String(meta.project_key || '')
  return {
    canonicalUuid,
    identifier,
    key,
    lookupIds: new Set([projectRef, canonicalUuid, identifier, key].filter(Boolean)),
  }
}

async function getPhaseDependencies(phaseCode: string, reviewType: string): Promise<string[]> {
  const rows = await qAll(phaseTpl, (v: any) =>
    v.phase_code === phaseCode && normalizeReviewType(v.review_type) === normalizeReviewType(reviewType),
  )
  return [...new Set(jsonArr(rows[0]?.dependencies || '[]').map(String).filter(Boolean))]
}

async function getClosedPassingPhases(projectIds: Set<string>, reviewType: string): Promise<Set<string>> {
  const candidates = await qAll(review, (v: any) =>
    projectIds.has(String(v.project_uuid || '')) &&
    normalizeReviewType(v.review_type) === normalizeReviewType(reviewType),
  )
  const passed = new Set<string>()
  for (const candidate of candidates) {
    const state = getEffectiveState(candidate)
    if (state !== 'completed' && state !== 'archived') continue
    const resolutions = await qAll(resolution, (v: any) => v.review_uuid === candidate.review_uuid)
    const latest = getLatestResolution(resolutions, Number(candidate.round_no || 1))
    if (latest?.final_conclusion === 'pass' || latest?.final_conclusion === 'conditional_pass') {
      passed.add(String(candidate.phase_code || ''))
    }
  }
  return passed
}

export async function Enable() {
  Logger.info('[DCP v1.18.0] Enable — 状态机迁移 + ReviewerWorkspace ready')

  // 状态机迁移：为旧数据回填 review_state / round_no / round_state
  try {
    const allReviews = await qAll(review)
    let migrated = 0
    for (const rv of allReviews) {
      if (rv.review_state) continue  // 已有 review_state，跳过
      const derivedState = getEffectiveState(rv)
      await review.set(rv.review_uuid, cleanForSet({
        ...rv,
        review_state: derivedState,
        round_no: Number(rv.round_no) || 1,
        round_state: stateToRoundState(derivedState),
        state_history_json: JSON.stringify([{
          state: derivedState,
          at: Date.now(),
          by: 'system',
          reason: '迁移：从旧 status 回填',
          round_no: Number(rv.round_no) || 1,
          from_state: '',
        }]),
      }))
      migrated++
    }
    if (migrated > 0) {
      Logger.info(`[DCP] 状态机迁移完成：${migrated} 条评审单已回填 review_state`)
    }
  } catch (e) {
    Logger.info('[DCP] 状态机迁移跳过（可能已迁移或无数据）')
  }

  const n = await roleTpl.query().count()
  if (n > 0) return
  const roles = [
    { role_name: 'Chair', must_vote: true, has_veto: true },
    { role_name: '研发VP', must_vote: true, has_veto: false },
    { role_name: '市场VP', must_vote: true, has_veto: false },
    { role_name: '财务代表', must_vote: true, has_veto: true },
    { role_name: '质量代表', must_vote: true, has_veto: true },
    { role_name: '供应链代表', must_vote: true, has_veto: false },
  ]
  for (let i = 0; i < roles.length; i++) {
    await roleTpl.set(`role_${i}`, { ...roles[i], sort_order: i })
  }
  Logger.info('[DCP] Default reviewer roles initialized')
}

export function Upgrade(oldVersion: any) {
  Logger.info('[DCP v1.5.3] Upgrade from:', JSON.stringify(oldVersion))
  Logger.info('[DCP v1.5.0] Entity migration: file fields on dcp_review_material already registered')
}

// ============================================================
// ProjectCustomComponent — 数据复制
// ============================================================
export async function copyPluginDataForDCP(_req: any): Promise<PluginResponse> {
  return { body: { code: 200, body: { state: 0, message: 'success' } } }
}

// ============================================================
// IPD 流程图默认布局
// ============================================================
const DEFAULT_IPD_FLOW_LAYOUT = {
  stages: [
    { code: 'concept', name: '概念', shape: 'taper', widthRatio: 1.1 },
    { code: 'plan', name: '计划', shape: 'taper', widthRatio: 1.5 },
    { code: 'develop', name: '开发', shape: 'rect', widthRatio: 2.8 },
    { code: 'confirm', name: '确认', shape: 'rect', widthRatio: 1.5 },
    { code: 'release', name: '发布', shape: 'rect', widthRatio: 1.4 },
  ],
  markers: [
    { phaseCode: 'DCP1', reviewType: 'dcp', stage: 'concept', position: 1, side: 'top', shape: 'diamond' },
    { phaseCode: 'TR1', reviewType: 'tr', stage: 'concept', position: 1, side: 'bottom', shape: 'triangle' },
    { phaseCode: 'TR2', reviewType: 'tr', stage: 'plan', position: 0.35, side: 'bottom', shape: 'triangle' },
    { phaseCode: 'DCP2', reviewType: 'dcp', stage: 'plan', position: 1, side: 'top', shape: 'diamond' },
    { phaseCode: 'TR3', reviewType: 'tr', stage: 'plan', position: 1, side: 'bottom', shape: 'triangle' },
    { phaseCode: 'DCP3', reviewType: 'dcp', stage: 'develop', position: 0.55, side: 'top', shape: 'diamond' },
    { phaseCode: 'TR4', reviewType: 'tr', stage: 'develop', position: 0.5, side: 'bottom', shape: 'triangle' },
    { phaseCode: 'DCP4', reviewType: 'dcp', stage: 'develop', position: 1, side: 'top', shape: 'diamond' },
    { phaseCode: 'TR5', reviewType: 'tr', stage: 'develop', position: 1, side: 'bottom', shape: 'triangle' },
    { phaseCode: 'DCP5', reviewType: 'dcp', stage: 'confirm', position: 1, side: 'top', shape: 'diamond' },
    { phaseCode: 'TR6', reviewType: 'tr', stage: 'confirm', position: 1, side: 'bottom', shape: 'triangle' },
  ],
}

// ============================================================
// 决议规则配置（resolution_rule_config）
// DCP/TR 分别配置发布人、提交要求、通过规则、可选决议结果
// 存储于 dcp_base_config，key=resolution_rule_config，value=JSON 字符串
// ============================================================
const DEFAULT_RESOLUTION_RULES: any = {
  dcp: {
    publisher: { mode: 'single_role', role: 'Chair' },
    submitRequirement: { mode: 'vote_scope_roles' },
    passRule: {
      mode: 'min_approval_count',
      minCount: 3,
      approvalConclusions: ['pass', 'conditional_pass'],
      voteScope: { mode: 'must_vote_roles', selectedRoles: [], excludeRoles: ['Chair'] },
      rejectOnAnyVeto: true,
    },
    allowedConclusions: ['pass', 'conditional_pass', 'reject'],
    // 决议门径硬约束：发布「通过」前校验指标红线 / Checklist 完整 / 前置阶段有效
    gatePolicy: {
      indicatorRedLine: 'block',     // block | warn | off
      indicatorGateMode: 'red_only', // red_only | red_and_yellow
      checklistComplete: 'block',     // block | warn | off
      checklistScope: 'all',          // all | required_roles
      prerequisiteRecheck: true,      // 复查前置阶段决议仍有效
      enforceOn: ['pass'],            // 只对 pass 硬卡；conditional_pass/rework/fail/reject 放行
    },
  },
  tr: {
    publisher: { mode: 'single_role', role: '' },
    submitRequirement: { mode: 'must_vote_roles' },
    passRule: {
      mode: 'all_required_submitted',
      approvalConclusions: ['pass', 'conditional_pass'],
      rejectConclusions: ['fail', 'rework', 'reject'],
      voteScope: { mode: 'must_vote_roles', selectedRoles: [], excludeRoles: [] },
      rejectOnAnyVeto: true,
    },
    allowedConclusions: ['pass', 'conditional_pass', 'fail', 'rework'],
    // 决议门径硬约束（TR 同样适用，见上方 DCP 注释）
    gatePolicy: {
      indicatorRedLine: 'block',
      indicatorGateMode: 'red_only',
      checklistComplete: 'block',
      checklistScope: 'all',
      prerequisiteRecheck: true,
      enforceOn: ['pass'],
    },
  },
}

// 从规则配置中获取唯一决议角色（兼容旧版 publisher.roles 数组）
function getPublisherRole(rule: any): string {
  if (!rule?.publisher) return ''
  if (rule.publisher.role) return rule.publisher.role
  if (Array.isArray(rule.publisher.roles) && rule.publisher.roles.length > 0) return rule.publisher.roles[0]
  return ''
}

// 判断某个 user_uuid 是否是本评审的决议发布角色
async function isPublisherRole(rv: any, userUuid: string): Promise<boolean> {
  let _rule: any
  try {
    _rule = await getResolutionRuleForReview(rv)
  } catch { return false }
  const _pubRole = getPublisherRole(_rule)
  if (!_pubRole) return false
  const rid = (rv as any).review_uuid
  let allRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  if (allRvrs.length === 0) allRvrs = jsonArr((rv as any).reviewers_json || '[]')
  const me = allRvrs.find((r: any) => r.reviewer_uuid === userUuid)
  return !!(me && me.role_name === _pubRole)
}

// 深度合并：以默认规则为骨架，savedR 中存在的字段覆盖默认值
function deepMergeRule(defaultR: any, savedR: any): any {
  if (!savedR || typeof savedR !== 'object' || Array.isArray(savedR)) return defaultR
  const result: any = {}
  for (const k of Object.keys(defaultR)) {
    const dv = defaultR[k]
    const sv = savedR[k]
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      result[k] = deepMergeRule(dv, sv)
    } else if (Array.isArray(dv)) {
      result[k] = Array.isArray(sv) ? sv : dv
    } else {
      result[k] = sv !== undefined ? sv : dv
    }
  }
  // 保留 savedR 中的额外字段
  for (const k of Object.keys(savedR)) {
    if (result[k] === undefined) result[k] = savedR[k]
  }
  return result
}

async function getResolutionRuleConfig(): Promise<any> {
  try {
    const row = await baseCfg.get('resolution_rule_config')
    if (row && (row as any).value) {
      const saved = JSON.parse((row as any).value)
      const migrated = migrateRuleConfig(saved)
      return {
        dcp: deepMergeRule(DEFAULT_RESOLUTION_RULES.dcp, migrated.dcp),
        tr: deepMergeRule(DEFAULT_RESOLUTION_RULES.tr, migrated.tr),
      }
    }
  } catch { /* 使用默认值 */ }
  return JSON.parse(JSON.stringify(DEFAULT_RESOLUTION_RULES))
}

// 迁移旧配置：passRule.excludeRoles → passRule.voteScope.excludeRoles
function migrateRuleConfig(saved: any): any {
  if (!saved || typeof saved !== 'object') return saved
  const result = JSON.parse(JSON.stringify(saved))
  for (const rt of ['dcp', 'tr']) {
    const rule = result[rt]
    if (!rule) continue
    // 迁移 publisher.roles → publisher.role
    if (rule.publisher) {
      if (Array.isArray(rule.publisher.roles) && rule.publisher.roles.length > 0) {
        rule.publisher.role = rule.publisher.role || rule.publisher.roles[0]
      }
      rule.publisher.mode = 'single_role'
      delete rule.publisher.roles
    }
    // passRule 迁移
    if (!rule.passRule) continue
    const pr = rule.passRule
    // 如果有旧的 excludeRoles 但没有 voteScope，迁移
    if (pr.excludeRoles && !pr.voteScope) {
      pr.voteScope = { mode: 'must_vote_roles', selectedRoles: [], excludeRoles: pr.excludeRoles }
      delete pr.excludeRoles
    }
    // 如果 voteScope 存在但缺字段，补齐
    if (pr.voteScope) {
      pr.voteScope.mode = pr.voteScope.mode || 'must_vote_roles'
      pr.voteScope.selectedRoles = pr.voteScope.selectedRoles || []
      pr.voteScope.excludeRoles = pr.voteScope.excludeRoles || []
    }
  }
  return result
}

async function getResolutionRuleByType(reviewType: string): Promise<any> {
  const cfg = await getResolutionRuleConfig()
  const type = reviewType === 'tr' ? 'tr' : 'dcp'
  return cfg[type] || JSON.parse(JSON.stringify(DEFAULT_RESOLUTION_RULES[type]))
}

// 构建冻结决议规则：在评审单创建时把当前规则 + 依赖角色模板的展开结果一次性固化
// 后续所有流程读取冻结规则，不再依赖实时角色模板配置
async function buildFrozenRule(reviewType: string): Promise<any> {
  const rule = await getResolutionRuleByType(reviewType)
  const roleTemplates = filterRolesByType(await qAll(roleTpl), reviewType)
  return {
    ...rule,
    _frozen: {
      publisherRole: getPublisherRole(rule),
      voteScopeRoleNames: resolveVoteScopeRoleNames(rule, roleTemplates),
      mustVoteRoleNames: roleTemplates.filter((r: any) => r.must_vote).map((r: any) => r.role_name),
      mustVoteOrVetoNames: roleTemplates.filter((r: any) => r.must_vote || r.has_veto).map((r: any) => r.role_name),
      vetoRoleNames: roleTemplates.filter((r: any) => r.has_veto).map((r: any) => r.role_name),
    },
  }
}

function withPhaseDependencySnapshot(
  rule: any, projectIdentity: CanonicalProjectIdentity, dependencies: string[], capturedAt: number,
): any {
  return {
    ...rule,
    _phase: {
      canonicalProjectUuid: projectIdentity.canonicalUuid,
      projectIdentifier: projectIdentity.identifier,
      dependencies: [...new Set(dependencies.map(String).filter(Boolean))],
      capturedAt,
    } as PhaseDependencySnapshot,
  }
}

function getPhaseDependencySnapshot(rv: any): PhaseDependencySnapshot | null {
  try {
    const snapshot = JSON.parse(String(rv?.resolution_rule_json || ''))._phase
    if (!snapshot || !Array.isArray(snapshot.dependencies) || !Number(snapshot.capturedAt || 0)) return null
    return {
      canonicalProjectUuid: String(snapshot.canonicalProjectUuid || ''),
      projectIdentifier: String(snapshot.projectIdentifier || ''),
      dependencies: [...new Set<string>(snapshot.dependencies.map((value: any) => String(value)).filter(Boolean))],
      capturedAt: Number(snapshot.capturedAt),
    }
  } catch {
    return null
  }
}

// 从评审单读取固化的决议规则；旧数据无固化规则时返回错误
async function getResolutionRuleForReview(rv: any): Promise<any> {
  const raw = (rv as any).resolution_rule_json
  if (raw) {
    try {
      const rule = JSON.parse(raw)
      if (rule && Array.isArray(rule.allowedConclusions)) {
        return rule
      }
    } catch { /* 格式损坏，走错误路径 */ }
  }
  throw new Error('当前评审单缺少固化决议规则，请重新创建评审单或联系管理员处理')
}

// ============================================================
// 配置固化兜底读取函数
// 旧数据无固化字段时回退实时模板，新数据优先用固化字段
// ============================================================

// 读取评审单固化的角色模板；旧数据无固化时回退实时 roleTpl
async function getRoleTemplatesForReview(rv: any): Promise<any[]> {
  const raw = (rv as any).role_templates_json
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length > 0) return arr
    } catch { /* 格式损坏，走实时兜底 */ }
  }
  const reviewType = (rv as any).review_type || 'dcp'
  return filterRolesByType(await qAll(roleTpl), reviewType)
}

// 读取评审单固化的 Checklist 模板；旧数据无固化时回退实时 checkItem
async function getChecklistTemplatesForReview(rv: any): Promise<any[]> {
  const raw = (rv as any).checklist_templates_json
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr
    } catch { /* 格式损坏，走实时兜底 */ }
  }
  const reviewType = (rv as any).review_type || 'dcp'
  return await qAll(checkItem, (v: any) => v.phase_code === (rv as any).phase_code && (v.review_type || 'dcp') === reviewType)
}

// 读取材料实体固化的 required 字段；旧数据无固化时回退实时 matTpl
async function getMaterialRequired(mat: any): Promise<number> {
  if (mat.required !== undefined && mat.required !== null && mat.required !== '') {
    return Number(mat.required) || 0
  }
  const tpl = (await qAll(matTpl)).find((t: any) => t._key === mat.template_id) as any
  return tpl?.required ? 1 : 0
}

// 读取材料实体固化的名称；旧数据无固化时回退实时 matTpl
async function getMaterialName(mat: any): Promise<string> {
  if (mat.material_name) return mat.material_name
  const tpl = (await qAll(matTpl)).find((t: any) => t._key === mat.template_id) as any
  return tpl?.material_name || mat.template_id || ''
}

// 读取指标实体固化的阈值配置；旧数据无固化时回退实时 indTpl
// 返回 { threshold_type, yellow_threshold, red_threshold, indicator_name } 或 null
async function getIndicatorThreshold(ind: any): Promise<any> {
  if (ind.threshold_type !== undefined && ind.threshold_type !== null && ind.threshold_type !== '') {
    return {
      threshold_type: ind.threshold_type,
      yellow_threshold: Number(ind.yellow_threshold ?? 0),
      red_threshold: Number(ind.red_threshold ?? 0),
      indicator_name: ind.indicator_name || '',
    }
  }
  const tpl = (await qAll(indTpl)).find((t: any) => t._key === ind.template_id) as any
  if (!tpl) return null
  return {
    threshold_type: tpl.threshold_type || '',
    yellow_threshold: Number(tpl.yellow_threshold ?? 0),
    red_threshold: Number(tpl.red_threshold ?? 0),
    indicator_name: tpl.indicator_name || '',
  }
}

// 计算指标红黄绿颜色（优先用固化阈值，回退实时模板）
async function calcRiskColor(ind: any, value: number): Promise<string> {
  const cfg = await getIndicatorThreshold(ind)
  if (!cfg || !cfg.threshold_type) return 'green'
  let color = 'green'
  if (cfg.threshold_type === '高于阈值预警') {
    if (value > cfg.red_threshold) color = 'red'
    else if (value > cfg.yellow_threshold) color = 'yellow'
  } else if (cfg.threshold_type === '低于阈值预警') {
    if (value < cfg.red_threshold) color = 'red'
    else if (value < cfg.yellow_threshold) color = 'yellow'
  }
  return color
}

// 按 review_type 过滤角色模板
function filterRolesByType(roleTemplates: any[], reviewType: string): any[] {
  return roleTemplates.filter((rt: any) => (rt.review_type || 'dcp') === reviewType)
}

// 解析计票范围内的角色名称列表
function resolveVoteScopeRoleNames(rule: any, roleTemplates: any[]): string[] {
  const scope = rule.passRule?.voteScope || {}
  const mode = scope.mode || 'must_vote_roles'
  const excludeRoles = scope.excludeRoles || []
  const selectedRoles = scope.selectedRoles || []
  let roles: any[]
  if (mode === 'all_reviewers') {
    roles = roleTemplates
  } else if (mode === 'selected_roles') {
    roles = roleTemplates.filter((rt: any) => selectedRoles.includes(rt.role_name))
  } else {
    roles = roleTemplates.filter((rt: any) => rt.must_vote)
  }
  return roles.map((rt: any) => rt.role_name).filter((n: string) => !excludeRoles.includes(n))
}

// 校验通过规则（发布决议时调用）
// 优先使用冻结规则中的 _frozen 角色范围；无 _frozen 时回退到实时 roleTemplates
function validatePassRule(
  passRule: any, allRvrs: any[], roleTemplates: any[], fc: string, frozen?: any,
): { ok: boolean; error?: string } {
  const mode = passRule.mode || 'min_approval_count'
  const approvalConclusions = passRule.approvalConclusions || ['pass', 'conditional_pass']

  // 一票否决检查（仅对 pass 结论生效）
  if (passRule.rejectOnAnyVeto && fc === 'pass') {
    const vetoRoleNames = (frozen?.vetoRoleNames) || roleTemplates.filter((rt: any) => rt.has_veto).map((rt: any) => rt.role_name)
    const vetoRejects = allRvrs.filter((r: any) =>
      vetoRoleNames.includes(r.role_name) && (r.submitted_at > 0) &&
      !approvalConclusions.includes(r.conclusion),
    )
    if (vetoRejects.length > 0) {
      return { ok: false, error: `存在否决权角色投了反对票，不可决议为「通过」：${vetoRejects.map((r: any) => r.role_name).join('、')}` }
    }
  }

  // 非通过结论不校验通过规则
  if (fc !== 'pass') return { ok: true }

  if (mode === 'min_approval_count') {
    const scopeNames = (frozen?.voteScopeRoleNames) || resolveVoteScopeRoleNames({ passRule }, roleTemplates)
    const candidates = allRvrs.filter((r: any) => scopeNames.includes(r.role_name))
    const approvals = candidates.filter((r: any) => approvalConclusions.includes(r.conclusion))
    const minCount = passRule.minCount || 3
    // 区分规则不可达 vs 投票未达标
    if (candidates.length < minCount) {
      return { ok: false, error: `当前评审单可计票评审人只有 ${candidates.length} 人，但规则要求至少 ${minCount} 人通过，请补充评审人或调整规则。` }
    }
    if (approvals.length < minCount) {
      return { ok: false, error: `决议为「通过」需至少 ${minCount} 位评审人投通过/有条件通过，当前仅 ${approvals.length} 位` }
    }
  } else if (mode === 'all_required_approved') {
    const mustVoteNames = (frozen?.mustVoteRoleNames) || roleTemplates.filter((rt: any) => rt.must_vote).map((rt: any) => rt.role_name)
    const notApproved = allRvrs.filter((r: any) =>
      mustVoteNames.includes(r.role_name) && (r.submitted_at > 0) &&
      !approvalConclusions.includes(r.conclusion),
    )
    if (notApproved.length > 0) {
      return { ok: false, error: `以下必投角色未投通过/有条件通过：${notApproved.map((r: any) => r.role_name).join('、')}` }
    }
  }
  // all_required_submitted 模式：只要求已提交，不校验通过数
  return { ok: true }
}

// 决议门径硬约束校验（发布决议时调用）
// 仅对 gatePolicy.enforceOn 中的结论生效（默认仅 pass）：指标红线 / Checklist 未全勾 / 前置阶段未通过
// block 阻断返回违规、warn 放行但记审计、off 跳过；旧评审单无 gatePolicy 时回退默认
async function validateResolutionGate(
  rv: any, rule: any, fc: string,
  snapshotIndicators: any[], snapshotChecklist: any[],
  projectIds: Set<string>,
): Promise<{ ok: boolean; violations: any[]; warnings: any[]; suggestDowngrade?: string }> {
  const reviewType = normalizeReviewType((rv as any).review_type || 'dcp')
  const gp = rule?.gatePolicy || DEFAULT_RESOLUTION_RULES[reviewType]?.gatePolicy || {}
  const enforceOn: string[] = Array.isArray(gp.enforceOn) ? gp.enforceOn : ['pass']
  if (!enforceOn.includes(fc)) return { ok: true, violations: [], warnings: [] }

  const violations: any[] = []
  const warnings: any[] = []

  // 1. 指标门径：按 risk_color 判定（risk_color 由 updateIndicators 经 calcRiskColor 写入）
  if (gp.indicatorRedLine && gp.indicatorRedLine !== 'off') {
    const badColors = gp.indicatorGateMode === 'red_and_yellow' ? ['red', 'yellow'] : ['red']
    const bad = (snapshotIndicators || []).filter((i: any) => badColors.includes(i.risk_color))
    if (bad.length > 0) {
      const v = { type: 'indicator_red', items: bad.map((i: any) => ({ indicator_name: i.indicator_name || '', risk_color: i.risk_color })) }
      if (gp.indicatorRedLine === 'block') violations.push(v); else warnings.push(v)
    }
  }

  // 2. Checklist 门径：整单或必投/否决角色范围无 unchecked
  if (gp.checklistComplete && gp.checklistComplete !== 'off') {
    let items: any[] = snapshotChecklist || []
    if (gp.checklistScope === 'required_roles') {
      const mustNames: string[] = (rule?._frozen?.mustVoteOrVetoNames) || []
      items = items.filter((c: any) => mustNames.includes(c.role_name))
    }
    const unchecked = items.filter((c: any) => !c.status || c.status === 'unchecked')
    if (unchecked.length > 0) {
      const v = { type: 'checklist_incomplete', items: unchecked.map((c: any) => ({ text: c.text || c.check_item || '', role_name: c.role_name || '' })) }
      if (gp.checklistComplete === 'block') violations.push(v); else warnings.push(v)
    }
  }

  // 3. 前置阶段门径：复查依赖阶段决议仍为 pass/conditional_pass 且未撤回
  if (gp.prerequisiteRecheck !== false) {
    const deps = await getPhaseDependencies((rv as any).phase_code || '', reviewType)
    if (deps.length > 0) {
      const passed = await getClosedPassingPhases(projectIds, reviewType)
      const missing = deps.filter((d: string) => !passed.has(d))
      if (missing.length > 0) {
        violations.push({ type: 'prerequisite_not_passed', items: missing.map((d: string) => ({ phase_code: d })) })
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    suggestDowngrade: violations.length > 0 ? 'conditional_pass' : undefined,
  }
}

// 决议规则可达性校验（保存配置/发起评审时调用）
function validateResolutionRuleReachability(rule: any, roleTemplates: any[], reviewType: string): string {
  const rtLabel = reviewType.toUpperCase()
  // 校验 1：决议角色不能为空
  const publisherRole = getPublisherRole(rule)
  if (!publisherRole) {
    return `${rtLabel} 决议角色未配置，请选择一个允许发布决议的角色。`
  }
  // 校验 1.5：决议角色必须存在于当前 review_type 的角色模板中
  if (!roleTemplates.some((rt: any) => rt.role_name === publisherRole)) {
    return `${rtLabel} 决议角色「${publisherRole}」不在当前${rtLabel}角色列表中，请重新配置。`
  }
  // 校验 2：可选决议结果不能为空
  if (!rule.allowedConclusions?.length) {
    return `${rtLabel} 可选最终决议结果不能为空，请至少选择一个结果。`
  }
  // 校验 3：允许"通过"时必须有有效通过规则
  if (rule.allowedConclusions.includes('pass') && !rule.passRule?.mode) {
    return `${rtLabel} 允许最终决议为"通过"，请配置对应的通过规则。`
  }
  // 校验 4/5：min_approval_count 的 minCount 不能大于可计票角色数
  if (rule.allowedConclusions.includes('pass') && rule.passRule?.mode === 'min_approval_count') {
    const scopeNames = resolveVoteScopeRoleNames(rule, roleTemplates)
    const minCount = Number(rule.passRule.minCount || 0)
    if (scopeNames.length === 0) {
      return `${rtLabel} 计票范围内没有可计票角色，请调整计票范围或角色配置。`
    }
    if (minCount > scopeNames.length) {
      return `${rtLabel} 计票范围内最多只有 ${scopeNames.length} 个角色可计票，最少通过人数不能设置为 ${minCount}。`
    }
  }
  // 校验 6：提交要求必须覆盖计票范围
  const submitMode = rule.submitRequirement?.mode || 'must_vote_roles'
  const voteScopeMode = rule.passRule?.voteScope?.mode || 'must_vote_roles'
  if (rule.passRule?.mode === 'min_approval_count') {
    if (submitMode === 'must_vote_roles' && voteScopeMode === 'all_reviewers') {
      return `${rtLabel} 通过规则依赖全部评审人投票，但发布前只要求必投角色提交。请改为"全部评审人提交"或"计票范围内角色全部提交"。`
    }
    if (submitMode === 'publisher_only') {
      return `${rtLabel} 通过规则要求至少 N 人通过，但发布前只要求发布人存在。请改为其他提交要求。`
    }
  }
  return '' // 校验通过
}

// 结论文案映射
function conclusionLabel(value: string): string {
  return ({
    pass: '通过',
    conditional_pass: '有条件通过',
    reject: '驳回',
    fail: '不通过',
    rework: '返工',
  } as Record<string, string>)[value] || '未记录'
}

// 判断评审单是否满足决议前置条件（按 submitRequirement.mode 判断）
// 排除决议角色——决议人不参与前置评审提交
// 优先使用冻结规则中的 _frozen 角色范围；无 _frozen 时回退到实时 roleTemplates
function isResolutionReady(rule: any, reviewers: any[], roleTemplates: any[]): boolean {
  const frozen = rule?._frozen
  const publisherRole = frozen?.publisherRole || getPublisherRole(rule)
  const frontReviewers = publisherRole ? reviewers.filter((r: any) => r.role_name !== publisherRole) : reviewers
  const submitMode = rule?.submitRequirement?.mode || 'must_vote_roles'
  if (submitMode === 'publisher_only') return true
  if (submitMode === 'all_reviewers') {
    return frontReviewers.length > 0 && frontReviewers.every((r: any) => r.submitted_at > 0)
  }
  if (submitMode === 'vote_scope_roles') {
    const scopeNames = (frozen?.voteScopeRoleNames) || resolveVoteScopeRoleNames(rule, roleTemplates)
    const scopeReviewers = frontReviewers.filter((r: any) => scopeNames.includes(r.role_name))
    if (scopeReviewers.length === 0) return false
    return scopeReviewers.every((r: any) => r.submitted_at > 0)
  }
  // must_vote_roles
  const mustVoteNames = (frozen?.mustVoteOrVetoNames) || roleTemplates.filter((rt: any) => rt.must_vote || rt.has_veto).map((rt: any) => rt.role_name)
  const mustReviewers = frontReviewers.filter((r: any) => mustVoteNames.includes(r.role_name))
  if (mustReviewers.length === 0) return false
  return mustReviewers.every((r: any) => r.submitted_at > 0)
}

// ============================================================
// 状态机 — 完整状态流转
// ============================================================

// 主状态枚举
const REVIEW_STATES = [
  'draft', 'ready', 'reviewing', 'awaiting_resolution',
  'resolution_published', 'remediation_pending', 're_reviewing',
  'completed', 'rejected', 'canceled', 'archived',
] as const

// 合法流转表
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:               ['ready', 'reviewing', 'canceled'],
  ready:               ['reviewing', 'draft', 'canceled'],
  reviewing:           ['awaiting_resolution', 'remediation_pending', 'draft', 'canceled'],
  awaiting_resolution: ['resolution_published', 'remediation_pending', 'reviewing', 'canceled'],
  resolution_published:['completed', 'rejected', 'remediation_pending'],
  remediation_pending: ['re_reviewing', 'canceled'],
  re_reviewing:        ['awaiting_resolution', 'canceled'],
  completed:           ['archived'],
  rejected:            ['draft', 'archived'],
  canceled:            ['archived', 'draft', 'reviewing'],
  archived:            [],
}

// review_state → 旧 status 兼容映射
function stateToStatus(reviewState: string): string {
  switch (reviewState) {
    case 'draft': case 'ready': case 'canceled': return 'draft'
    case 'reviewing': case 'awaiting_resolution': case 're_reviewing': case 'remediation_pending': return 'reviewing'
    case 'completed': case 'archived': return 'completed'
    case 'rejected': return 'rejected'
    default: return 'draft'
  }
}

// review_state → round_state 映射
function stateToRoundState(reviewState: string): string {
  switch (reviewState) {
    case 'draft': case 'ready': return 'draft'
    case 'reviewing': return 'running'
    case 'awaiting_resolution': return 'waiting_resolution'
    case 'resolution_published': return 'resolved'
    case 'remediation_pending': return 'remediation_pending'
    case 're_reviewing': return 're_reviewing'
    case 'completed': case 'rejected': case 'canceled': case 'archived': return 'closed'
    default: return 'draft'
  }
}

// 从实体读取有效 review_state（兼容旧数据：review_state 为空时从 status 推导）
function getEffectiveState(rv: any): string {
  if (rv.review_state) return rv.review_state
  // 旧数据兼容：status → review_state
  const s = rv.status || 'draft'
  if (s === 'draft') return 'draft'
  if (s === 'reviewing') return 'reviewing'
  if (s === 'completed') return 'completed'
  if (s === 'rejected') return 'rejected'
  return 'draft'
}

// 追加状态历史记录，返回新 JSON 字符串
function appendStateHistory(rv: any, newState: string, by: string, reason: string, roundNo?: number): string {
  const history = jsonArr(rv.state_history_json || '[]')
  history.push({
    state: newState,
    at: Date.now(),
    by: by || '',
    reason: reason || '',
    round_no: roundNo ?? Number(rv.round_no || 1),
    from_state: getEffectiveState(rv),
  })
  // 保留最近 100 条，防止 32KB 溢出
  if (history.length > 100) history.splice(0, history.length - 100)
  return JSON.stringify(history)
}

// 校验流转合法性
function isValidTransition(from: string, to: string): boolean {
  const valid = VALID_TRANSITIONS[from] || []
  return valid.includes(to)
}

// 执行状态流转（写入 review 实体 + 历史记录）
// 不单独 set——调用方在已有的 review.set 中合并新字段
function buildStateTransition(rv: any, newState: string, by: string, reason: string, extra?: Record<string, any>): Record<string, any> {
  const currentState = getEffectiveState(rv)
  if (currentState !== newState && !isValidTransition(currentState, newState)) {
    throw new Error(`非法状态流转: ${currentState} -> ${newState}`)
  }
  // 进入 re_reviewing 时开启新轮次——先算出新 round_no，再传给 appendStateHistory
  let newRoundNo = Number(rv.round_no || 1)
  if (newState === 're_reviewing' && currentState === 'remediation_pending') {
    newRoundNo = newRoundNo + 1
  }
  const historyJson = appendStateHistory(rv, newState, by, reason, newRoundNo)
  const newStatus = stateToStatus(newState)
  const newRoundState = stateToRoundState(newState)
  return {
    ...extra,
    review_state: newState,
    status: newStatus,
    round_no: newRoundNo,
    round_state: newRoundState,
    state_history_json: historyJson,
    updated_at: Date.now(),
  }
}

// ============================================================
// 配置
// ============================================================
export async function getPluginConfig(_req: any): Promise<PluginResponse> {
  const keys = ['default_resolution_template', 'remediation_issue_type', 'remediation_issue_type_uuid']
  const config: any = {}
  for (const k of keys) {
    const v = await baseCfg.get(k)
    config[k] = (v as any)?.value || ''
  }
  // IPD 流程图布局
  let ipdFlowLayout: any = DEFAULT_IPD_FLOW_LAYOUT
  try {
    const fl = await baseCfg.get('ipd_flow_layout')
    if (fl && (fl as any).value) {
      ipdFlowLayout = JSON.parse((fl as any).value)
    }
  } catch { /* 使用默认值 */ }
  const withType = (arr: any[]) => arr.map((x: any) => ({ ...x, review_type: x.review_type || 'dcp' }))
  return { body: {
    config,
    ipd_flow_layout: ipdFlowLayout,
    notify_config: await getNotifyConfig(),
    review_recall_config: await getReviewRecallConfig(),
    resolution_rule_config: await getResolutionRuleConfig(),
    phases: withType(await qAll(phaseTpl)),
    materials: withType(await qAll(matTpl)),
    indicators: withType(await qAll(indTpl)),
    roles: withType(await qAll(roleTpl)),
    checklistItems: withType(await qAll(checkItem)),
  }}
}

export async function savePluginConfig(req: any): Promise<PluginResponse> {
  try {
    // 方案B：仅管理员可保存全局配置
    const operator_uuid = getOperator(req)
    if (!operator_uuid) {
      return { body: { error: '无法获取当前用户身份' }, statusCode: 401 }
    }
    const b = (req.body || {}) as any
    if (b.config) {
      for (const [k, v] of Object.entries(b.config)) {
        await baseCfg.set(k as string, { key: k, value: v as string })
      }
    }
    const replace = async (store: any, items: any[], prefix: string, allowedExtra: string[] = []) => {
      const old = await qAll(store)
      const oldKeys = new Set(old.map((o: any) => o._key))
      if (Array.isArray(items)) {
        for (let i = 0; i < items.length; i++) {
          const { _key, dependencies, ...clean } = items[i]
          // 只对 phase 实体保留 dependencies
          const withDeps = allowedExtra.includes('dependencies') ? { ...clean, dependencies: dependencies || '[]' } : clean
          const key = `${prefix}_${i}`
          const rt = (clean as any).review_type || 'dcp'
          await store.set(key, { ...withDeps, review_type: rt, sort_order: clean.sort_order ?? i })
          oldKeys.delete(key)
        }
      }
      for (const k of oldKeys) {
        try { await store.delete(k) } catch { /* key 可能已不存在 */ }
      }
    }
    if (b.phases) await replace(phaseTpl, b.phases, 'phase', ['dependencies'])
    if (b.materials) await replace(matTpl, b.materials, 'mat')
    if (b.indicators) await replace(indTpl, b.indicators, 'ind')
    if (b.roles) await replace(roleTpl, b.roles, 'role')
    if (b.checklistItems) await replace(checkItem, b.checklistItems, 'chk')
    if (b.notify_config) await baseCfg.set('notify_config',
      { key: 'notify_config', value: typeof b.notify_config === 'string' ? b.notify_config : JSON.stringify(b.notify_config) })
    if (b.review_recall_config) await baseCfg.set('review_recall_config',
      { key: 'review_recall_config', value: typeof b.review_recall_config === 'string' ? b.review_recall_config : JSON.stringify(b.review_recall_config) })
    if (b.ipd_flow_layout) await baseCfg.set('ipd_flow_layout',
      { key: 'ipd_flow_layout', value: typeof b.ipd_flow_layout === 'string' ? b.ipd_flow_layout : JSON.stringify(b.ipd_flow_layout) })
    if (b.resolution_rule_config) {
      const rawRule = typeof b.resolution_rule_config === 'string'
        ? JSON.parse(b.resolution_rule_config)
        : b.resolution_rule_config
      // 保存前做可达性校验
      const allRoles = await qAll(roleTpl)
      for (const rt of ['dcp', 'tr']) {
        const rule = rawRule[rt]
        if (!rule) continue
        const typeRoles = filterRolesByType(allRoles, rt)
        const err = validateResolutionRuleReachability(rule, typeRoles, rt)
        if (err) {
          return { body: { error: err }, statusCode: 400 }
        }
      }
      await baseCfg.set('resolution_rule_config', { key: 'resolution_rule_config', value: JSON.stringify(rawRule) })
    }
    Logger.info(`[DCP] Config saved by ${operator_uuid || 'unknown'}`)
    return { body: { ok: true } }
  } catch (err: any) {
    Logger.error('[DCP] Config save failed:', err.message)
    return { body: { error: err.message }, statusCode: 500 }
  }
}

// ============================================================
// 创建评审单
// ============================================================
export async function createReview(req: any): Promise<PluginResponse> {
  const b = (req.body || {}) as any
  // 方案A：creator_uuid 使用真实身份，不信任前端传递
  const operatorUuid = getOperator(req)
  const { project_uuid, phase_code, review_title, meeting_time, review_type } = b
  const creator_uuid = operatorUuid || b.creator_uuid || ''
  if (!project_uuid || !phase_code) {
    return { body: { error: '缺少 project_uuid / phase_code' }, statusCode: 400 }
  }
  const rvUuid = makeUuid()
  const now = Date.now()
  const reviewType = normalizeReviewType(review_type)
  let projectIdentity: CanonicalProjectIdentity
  try {
    projectIdentity = await resolveCanonicalProjectIdentity(req, String(project_uuid))
  } catch (e: any) {
    return { body: { code: 'PROJECT_IDENTITY_UNAVAILABLE', error: e?.message || '无法确定项目身份' }, statusCode: 503 }
  }
  const phaseDependencies = await getPhaseDependencies(phase_code, reviewType)

  // 同项目、同阶段、同类型只允许一个活动或已通过评审；复审必须复用原评审单。
  const phaseConflict = await findPhaseReviewConflict(projectIdentity.lookupIds, phase_code, reviewType)
  if (phaseConflict) {
    const phaseName = (await qAll(phaseTpl, (v: any) =>
      v.phase_code === phase_code && normalizeReviewType(v.review_type) === normalizeReviewType(reviewType)))[0]?.phase_name || phase_code
    return phaseConflictResponse(phaseConflict, phaseName, reviewType)
  }

  // 固化决议规则：创建时把当前规则 + 依赖角色模板的展开结果一次性写入评审单
  let frozenRuleJson = ''
  try {
    const frozenRule = await buildFrozenRule(reviewType)
    frozenRuleJson = JSON.stringify(withPhaseDependencySnapshot(frozenRule, projectIdentity, phaseDependencies, now))
  } catch (e: any) {
    return { body: { error: `${reviewType.toUpperCase()} 决议规则读取失败: ${e.message || String(e)}` }, statusCode: 400 }
  }
  // 生成唯一编号: {项目标识}{YYYYMMDD}{两位序号}，序号计数器存 base_config
  const projectIdentifier = projectIdentity.identifier || projectIdentity.key || ''
  let reviewNumber = ''
  try {
    const d = new Date()
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    // entity key 只允许小写字母 /^[_a-z0-9]{1,64}$/，projectIdentifier 转小写
    const seqKey = `review_seq_${projectIdentifier.toLowerCase()}_${dateStr}`
    let seq = 1
    try {
      const seqRow = await baseCfg.get(seqKey)
      if (seqRow && (seqRow as any).value) { seq = parseInt(String((seqRow as any).value), 10) + 1 }
    } catch { /* key 不存在，首次创建 */ }
    await baseCfg.set(seqKey, { key: seqKey, value: String(seq) })
    reviewNumber = `${reviewType === 'tr' ? 'TR-' : ''}${projectIdentifier}${dateStr}${String(seq).padStart(2, '0')}`
  } catch (e: any) {
    // 编号生成失败不阻塞创建，用时间戳兜底
    reviewNumber = `${reviewType === 'tr' ? 'TR-' : ''}${projectIdentifier}${Date.now()}`
    Logger.info(`[DCP] review_number generation failed, fallback: ${reviewNumber}`)
  }
  // 固化角色模板和 Checklist 模板（创建时配置快照）
  const frozenRoles = filterRolesByType(await qAll(roleTpl), reviewType)
  const frozenChecklist = await qAll(checkItem, (v: any) => v.phase_code === phase_code && (v.review_type || 'dcp') === reviewType)
  const roleTemplatesJson = JSON.stringify(frozenRoles.map((r: any) => ({
    role_name: r.role_name, must_vote: r.must_vote || 0, has_veto: r.has_veto || 0,
    sort_order: r.sort_order ?? 0, review_type: r.review_type || reviewType,
  })))
  const checklistTemplatesJson = JSON.stringify(frozenChecklist.map((c: any) => ({
    template_id: c._key, phase_code: c.phase_code, role_name: c.role_name,
    item_text: c.item_text, sort_order: c.sort_order ?? 0,
  })))

  const claimedGuard = await claimPhaseGuard(projectIdentity.canonicalUuid, phase_code, reviewType, rvUuid)
  if (!claimedGuard.ok) {
    return {
      body: { code: 'REVIEW_PHASE_ALREADY_ACTIVE', error: '该项目阶段已有评审单，请刷新后继续原评审单', conflict_review_uuid: claimedGuard.existing?.review_uuid || '' },
      statusCode: 409,
    }
  }

  await review.set(rvUuid, cleanForSet({
    review_uuid: rvUuid,
    project_uuid: projectIdentity.canonicalUuid,
    phase_code,
    review_title: review_title || 'DCP评审', meeting_time: meeting_time || 0,
    status: 'draft',
    review_state: 'draft',
    round_no: 1,
    round_state: 'draft',
    state_history_json: JSON.stringify([{
      state: 'draft', at: now, by: creator_uuid || 'system',
      reason: '创建评审单', round_no: 1, from_state: '',
    }]),
    creator_uuid: creator_uuid || '',
    created_at: now, updated_at: now,
    review_number: reviewNumber,
    review_type: reviewType,
    resolution_rule_json: frozenRuleJson,
    config_frozen_at: now,
    config_version_note: '按创建时配置执行',
    role_templates_json: roleTemplatesJson,
    checklist_templates_json: checklistTemplatesJson,
  }))
  // 带出材料模板（含固化的名称/必填/责任角色/排序）
  const mats = await qAll(matTpl, (v: any) => jsonArr(v.applicable_phases).includes(phase_code) && (v.review_type || 'dcp') === reviewType)
  for (const m of mats) {
    await matItem.set(`${rvUuid}_mat_${m._key}`, {
      review_uuid: rvUuid, template_id: m._key, submit_status: 'pending',
      notes: '', updated_by: '', updated_at: 0,
      round_no: 1,
      material_name: m.material_name || '', required: m.required ? 1 : 0,
      responsible_role: m.responsible_role || '', sort_order: m.sort_order ?? 0,
    })
  }
  // 带出指标模板（含固化的名称/阈值/排序）
  const inds = await qAll(indTpl, (v: any) => jsonArr(v.applicable_phases).includes(phase_code) && (v.review_type || 'dcp') === reviewType)
  for (const i of inds) {
    await indData.set(`${rvUuid}_ind_${i._key}`, {
      review_uuid: rvUuid, template_id: i._key, current_value: 0,
      notes: '', risk_color: 'green', updated_by: '', updated_at: 0,
      round_no: 1,
      indicator_name: i.indicator_name || '', threshold_type: i.threshold_type || '',
      yellow_threshold: Number(i.yellow_threshold ?? 0), red_threshold: Number(i.red_threshold ?? 0),
      sort_order: i.sort_order ?? 0,
    })
  }
  await writeAudit(rvUuid, creator_uuid || '', '创建评审', rvUuid,
    `创建${reviewType === 'tr' ? 'TR' : 'DCP'}评审单: ${reviewNumber} - ${phase_code} - ${review_title || 'DCP评审'}`)

  // 自动解析项目绑定 → 冻结 Reviewer Profile 快照，并为 single 模式预填默认评审人
  let autoAppliedProfile = ''
  let autoAppliedCount = 0
  try {
    const bindings = await qAll(projectBinding, (v: any) =>
      v.project_uuid === projectIdentity.canonicalUuid && (v.review_type || 'dcp') === reviewType)
    if (bindings.length > 0) {
      const binding = bindings[0]
      const profile = await reviewerProfile.get(binding.profile_id)
      if (profile) {
        const roleTemplates = filterRolesByType(await qAll(roleTpl), reviewType)
        const assignments = normalizeRoleAssignments(jsonArr((profile as any).role_assignments_json || (profile as any).reviewers_json || '[]'))
        const snapshotReviewers = resolveAutoReviewers(assignments, roleTemplates)
        const savedPayload = await writeReviewersToEntities(rvUuid, snapshotReviewers, roleTemplates, review)
        const roleAssignmentsSnapshot = JSON.stringify(assignments)
        const profileSnapshot = JSON.stringify({
          profile_id: binding.profile_id,
          profile_name: (profile as any).profile_name || '',
          review_type: reviewType,
          role_assignments: assignments,
        })
        await review.set(rvUuid, cleanForSet({
          review_uuid: rvUuid, project_uuid, phase_code,
          review_title: review_title || 'DCP评审', meeting_time: meeting_time || 0,
          status: 'draft', review_state: 'draft', round_no: 1, round_state: 'draft',
          creator_uuid: creator_uuid || '', created_at: now, updated_at: now,
          review_number: reviewNumber, review_type: reviewType,
          resolution_rule_json: frozenRuleJson,
          config_frozen_at: now, config_version_note: '按创建时配置执行',
          role_templates_json: roleTemplatesJson, checklist_templates_json: checklistTemplatesJson,
          reviewers_json: JSON.stringify(savedPayload),
          reviewer_profile_id: binding.profile_id,
          reviewer_profile_name: (profile as any).profile_name || '',
          reviewer_profile_snapshot_json: profileSnapshot,
          reviewer_binding_snapshot_json: JSON.stringify(binding),
          reviewer_role_assignments_snapshot_json: roleAssignmentsSnapshot,
          state_history_json: JSON.stringify([{
            state: 'draft', at: now, by: creator_uuid || 'system',
            reason: '创建评审单', round_no: 1, from_state: '',
          }]),
        }))
        autoAppliedProfile = (profile as any).profile_name || binding.profile_id
        autoAppliedCount = savedPayload.filter((r: any) => r.reviewer_uuid).length
        await writeAudit(rvUuid, creator_uuid || '', '自动应用Profile', rvUuid,
          `从项目绑定自动应用评审人Profile「${autoAppliedProfile}」，共 ${savedPayload.length} 个角色快照`)
      }
    }
  } catch (e: any) {
    Logger.info(`[DCP] auto-apply profile failed for ${rvUuid}: ${e?.message || e}`)
  }

  return { body: {
    review_uuid: rvUuid,
    review_number: reviewNumber,
    materials_count: mats.length,
    indicators_count: inds.length,
    auto_applied_profile: autoAppliedProfile || undefined,
    auto_applied_count: autoAppliedCount || undefined,
    auto_reviewer_uuids: autoAppliedCount > 0
      ? (await qAll(rvReviewer, (v: any) => v.review_uuid === rvUuid)).map((v: any) => v.reviewer_uuid).filter(Boolean)
      : undefined,
  } }
}

// ============================================================
// 删除评审单（仅草稿，仅创建者）
// ============================================================
export async function deleteReview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  // 方案A+B：用真实身份校验，不信任前端 operator_uuid
  const operator_uuid = getOperator(req)
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  if (rv.status !== 'draft') return { body: { error: '仅草稿状态的评审单可删除' }, statusCode: 403 }
  if (operator_uuid && (rv as any).creator_uuid && operator_uuid !== (rv as any).creator_uuid) {
    return { body: { error: '仅创建者可删除' }, statusCode: 403 }
  }
  // 删除关联子实体
  const [mats, inds, chkResults, linkedIssues, auditLogs] = await Promise.all([
    qAll(matItem, (v: any) => v.review_uuid === rid),
    qAll(indData, (v: any) => v.review_uuid === rid),
    qAll(checkResult, (v: any) => v.review_uuid === rid),
    qAll(linkedIssue, (v: any) => v.review_uuid === rid),
    qAll(auditLog, (v: any) => v.review_uuid === rid),
  ])
  for (const m of mats) await matItem.delete((m as any)._key)
  for (const i of inds) await indData.delete((i as any)._key)
  for (const c of chkResults) await checkResult.delete((c as any)._key)
  for (const l of linkedIssues) await linkedIssue.delete((l as any)._key)
  for (const a of auditLogs) await auditLog.delete((a as any)._key)
  await review.delete(rid)
  await writeAudit(rid, operator_uuid || '', '删除评审', rid,
    `删除DCP评审单: ${(rv as any).phase_code || ''}`)
  return { body: { ok: true } }
}

// ============================================================
// 重新发起评审（从已驳回的评审单复制配置，创建新 draft 评审单）
// ============================================================
export async function recreateReview(req: any): Promise<PluginResponse> {
  const srcRid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A+B：用真实身份，校验仅创建者可重新发起
  const operator_uuid = getOperator(req)
  if (!srcRid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }

  const srcRv = await review.get(srcRid) as any
  if (!srcRv) return { body: { error: '源评审单不存在' }, statusCode: 404 }
  if (srcRv.status !== 'rejected') {
    return { body: { error: '仅已驳回的评审单可重新发起' }, statusCode: 400 }
  }
  if (operator_uuid && srcRv.creator_uuid && operator_uuid !== srcRv.creator_uuid) {
    return { body: { error: '仅创建者可重新发起评审' }, statusCode: 403 }
  }

  // 创建新评审单
  const newRid = makeUuid()
  const now = Date.now()
  // 重新发起使用当前最新配置固化规则（而非复制源单旧规则）
  const reviewType = normalizeReviewType(srcRv.review_type)
  const projectRef = String(srcRv.project_uuid || b.project_uuid || '')
  let projectIdentity: CanonicalProjectIdentity
  try {
    projectIdentity = await resolveCanonicalProjectIdentity(req, projectRef)
  } catch (e: any) {
    return { body: { code: 'PROJECT_IDENTITY_UNAVAILABLE', error: e?.message || '无法确定项目身份' }, statusCode: 503 }
  }
  const phaseDependencies = await getPhaseDependencies(srcRv.phase_code, reviewType)
  const phaseConflict = await findPhaseReviewConflict(projectIdentity.lookupIds, srcRv.phase_code, reviewType)
  if (phaseConflict) {
    return phaseConflictResponse(phaseConflict, srcRv.phase_code, reviewType)
  }
  let frozenRuleJson = ''
  try {
    const frozenRule = await buildFrozenRule(reviewType)
    frozenRuleJson = JSON.stringify(withPhaseDependencySnapshot(frozenRule, projectIdentity, phaseDependencies, now))
  } catch (e: any) {
    return { body: { error: `${reviewType.toUpperCase()} 决议规则读取失败: ${e.message || String(e)}` }, statusCode: 400 }
  }
  // 生成编号
  const projectIdentifier = projectIdentity.identifier || projectIdentity.key || ''
  let reviewNumber = ''
  try {
    const d = new Date()
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const seqKey = `review_seq_${projectIdentifier.toLowerCase()}_${dateStr}`
    let seq = 1
    try {
      const seqRow = await baseCfg.get(seqKey)
      if (seqRow && (seqRow as any).value) { seq = parseInt(String((seqRow as any).value), 10) + 1 }
    } catch { /* key 不存在 */ }
    await baseCfg.set(seqKey, { key: seqKey, value: String(seq) })
    reviewNumber = `${projectIdentifier}${dateStr}${String(seq).padStart(2, '0')}`
  } catch {
    reviewNumber = `${projectIdentifier}${Date.now()}`
  }

  // 复制评审人（从快照或实体），先于 review.set 以便写入 reviewers_json
  const snapReviewers = jsonArr(srcRv.reviewers_json || '[]')
  const srcReviewers = snapReviewers.length > 0 ? snapReviewers
    : await qAll(rvReviewer, (v: any) => v.review_uuid === srcRid)
  const newReviewers = srcReviewers.map((r: any) => ({
    role_name: r.role_name,
    reviewer_uuid: r.reviewer_uuid,
    reviewer_name: r.reviewer_name || '',
    submitted_at: 0,
    conclusion: '',
    risk_level: '',
    opinion_summary: '',
  }))

  // 固化角色模板和 Checklist 模板（用当前最新配置）
  const frozenRoles = filterRolesByType(await qAll(roleTpl), reviewType)
  const frozenChecklist = await qAll(checkItem, (v: any) => v.phase_code === srcRv.phase_code && (v.review_type || 'dcp') === reviewType)
  const roleTemplatesJson = JSON.stringify(frozenRoles.map((r: any) => ({
    role_name: r.role_name, must_vote: r.must_vote || 0, has_veto: r.has_veto || 0,
    sort_order: r.sort_order ?? 0, review_type: r.review_type || reviewType,
  })))
  const checklistTemplatesJson = JSON.stringify(frozenChecklist.map((c: any) => ({
    template_id: c._key, phase_code: c.phase_code, role_name: c.role_name,
    item_text: c.item_text, sort_order: c.sort_order ?? 0,
  })))

  const claimedGuard = await claimPhaseGuard(projectIdentity.canonicalUuid, srcRv.phase_code, reviewType, newRid)
  if (!claimedGuard.ok) {
    return { body: { code: 'REVIEW_PHASE_ALREADY_ACTIVE', error: '该项目阶段已有评审单，请刷新后继续原评审单', conflict_review_uuid: claimedGuard.existing?.review_uuid || '' }, statusCode: 409 }
  }

  await review.set(newRid, cleanForSet({
    review_uuid: newRid,
    project_uuid: projectIdentity.canonicalUuid,
    phase_code: srcRv.phase_code,
    review_title: srcRv.review_title || 'DCP评审',
    meeting_time: 0,
    status: 'draft',
    review_state: 'draft',
    round_no: 1,
    round_state: 'draft',
    state_history_json: JSON.stringify([{
      state: 'draft', at: now, by: operator_uuid || 'system',
      reason: `重新发起（源: ${srcRv.review_number || srcRid}）`, round_no: 1, from_state: '',
    }]),
    creator_uuid: operator_uuid || srcRv.creator_uuid || '',
    created_at: now,
    updated_at: now,
    review_number: reviewNumber,
    reviewers_json: JSON.stringify(newReviewers),
    review_type: reviewType,
    resolution_rule_json: frozenRuleJson,
    config_frozen_at: now,
    config_version_note: '按创建时配置执行',
    role_templates_json: roleTemplatesJson,
    checklist_templates_json: checklistTemplatesJson,
  }))

  // 以新模板为准重新带出材料，源单文件按 template_id 匹配保留
  const srcMats = await qAll(matItem, (v: any) => v.review_uuid === srcRid)
  const srcMatMap = new Map(srcMats.map((m: any) => [m.template_id, m]))
  const newMats = await qAll(matTpl, (v: any) => jsonArr(v.applicable_phases).includes(srcRv.phase_code) && (v.review_type || 'dcp') === reviewType)
  for (const m of newMats) {
    const src = srcMatMap.get(m._key) as any
    await matItem.set(`${newRid}_mat_${m._key}`, {
      review_uuid: newRid, template_id: m._key,
      submit_status: src?.file_data ? 'submitted' : 'pending',
      notes: '', updated_by: '', updated_at: 0, round_no: 1,
      material_name: m.material_name || '', required: m.required ? 1 : 0,
      responsible_role: m.responsible_role || '', sort_order: m.sort_order ?? 0,
      // 保留源单已上传的文件
      file_name: src?.file_name || '', file_data: src?.file_data || '',
      file_size: src?.file_size || 0, uploaded_at: src?.uploaded_at || 0,
      attachments_json: '[]',
    })
  }

  // 以新模板为准重新带出指标，源单 current_value 按 template_id 匹配保留
  const srcInds = await qAll(indData, (v: any) => v.review_uuid === srcRid)
  const srcIndMap = new Map(srcInds.map((i: any) => [i.template_id, i]))
  const newInds = await qAll(indTpl, (v: any) => jsonArr(v.applicable_phases).includes(srcRv.phase_code) && (v.review_type || 'dcp') === reviewType)
  for (const i of newInds) {
    const src = srcIndMap.get(i._key) as any
    const currentValue = Number(src?.current_value ?? 0)
    // 用新模板阈值重新计算颜色
    let color = 'green'
    if (i.threshold_type === '高于阈值预警') {
      if (currentValue > Number(i.red_threshold ?? 0)) color = 'red'
      else if (currentValue > Number(i.yellow_threshold ?? 0)) color = 'yellow'
    } else if (i.threshold_type === '低于阈值预警') {
      if (currentValue < Number(i.red_threshold ?? 0)) color = 'red'
      else if (currentValue < Number(i.yellow_threshold ?? 0)) color = 'yellow'
    }
    await indData.set(`${newRid}_ind_${i._key}`, {
      review_uuid: newRid, template_id: i._key, current_value: currentValue,
      notes: src?.notes || '', risk_color: color,
      updated_by: '', updated_at: 0, round_no: 1,
      indicator_name: i.indicator_name || '', threshold_type: i.threshold_type || '',
      yellow_threshold: Number(i.yellow_threshold ?? 0), red_threshold: Number(i.red_threshold ?? 0),
      sort_order: i.sort_order ?? 0,
    })
  }

  await writeAudit(newRid, operator_uuid, '创建评审', newRid,
    `重新发起评审（源: ${srcRv.review_number || srcRid}）: ${reviewNumber} - ${srcRv.phase_code}`)
  await writeAudit(srcRid, operator_uuid, '重新发起', newRid,
    `基于此评审单重新发起: ${reviewNumber}`)

  return { body: {
    review_uuid: newRid,
    review_number: reviewNumber,
    materials_count: newMats.length,
    indicators_count: newInds.length,
    reviewers_count: newReviewers.length,
  } }
}

// ============================================================
// 获取评审单详情（聚合）
// ============================================================
export async function getReviewDetail(req: any): Promise<PluginResponse> {
  try {
    const rid = getParam(req, 'review_uuid')
    Logger.info(`[DCP] getReviewDetail start, rid=${rid}`)
    if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
    const rv = await review.get(rid)
    Logger.info(`[DCP] getReviewDetail review.get ok, rv=${JSON.stringify(rv)?.substring(0, 200)}`)
    if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
    // 补充阶段名称
    const allPhases = await qAll(phaseTpl)
    const phMap = new Map(allPhases.map((p: any) => [p.phase_code, p.phase_name]))
    const rvWithPhase = { ...(rv as any), phase_name: phMap.get((rv as any).phase_code) || '', review_type: (rv as any).review_type || 'dcp' }
    // 优先读 reviewers_json 快照（绕过 qAll 不可见问题），兜底读实体
    const snapReviewers = jsonArr((rv as any).reviewers_json || '[]')
    Logger.info(`[DCP] getReviewDetail before Promise.all, rid=${rid}`)
    const [materials, indicators, entityReviewers, issues, resList, supps] = await Promise.all([
      qAll(matItem, (v: any) => v.review_uuid === rid),
      qAll(indData, (v: any) => v.review_uuid === rid),
      qAll(rvReviewer, (v: any) => v.review_uuid === rid),
      qAll(linkedIssue, (v: any) => v.review_uuid === rid),
      qAll(resolution, (v: any) => v.review_uuid === rid),
      qAll(supplement, (v: any) => v.review_uuid === rid),
    ])
    Logger.info(`[DCP] getReviewDetail Promise.all ok: mats=${materials.length}, inds=${indicators.length}, entity_rvrs=${entityReviewers.length}, snap_rvrs=${snapReviewers.length}, issues=${issues.length}, res=${resList.length}, supps=${supps.length}`)
    // 优先使用实体数据（source of truth），实体为空时兜底读快照
    let reviewers = entityReviewers.length > 0 ? entityReviewers : snapReviewers
    // 投影到当前轮次：如果 reviewer 的 round_no 不匹配当前轮次，视为未提交
    // （修复 confirmRemediation/transitionReview 重置实体时 qAll 返回空导致实体未更新的问题）
    const _projRoundNo = (rv as any).round_no || 1
    reviewers = reviewers.map((r: any) => {
      if ((r.round_no || 1) !== _projRoundNo) {
        return { ...r, submitted_at: 0, conclusion: '', risk_level: '', opinion_summary: '', round_no: _projRoundNo }
      }
      return r
    })
    // 优先使用实体固化的模板字段，旧数据回退实时模板
    const allMatTpls = await qAll(matTpl)
    const matsWithTpl = materials.map((m: any) => {
      const frozenTpl = (m.material_name !== undefined && m.material_name !== null && m.material_name !== '') ? {
        _key: m.template_id, material_name: m.material_name,
        required: m.required, responsible_role: m.responsible_role || '',
        sort_order: m.sort_order ?? 0,
      } : null
      const liveTpl = allMatTpls.find((t: any) => t._key === m.template_id) || null
      return { ...m, template: frozenTpl || liveTpl }
    })
    const allIndTpls = await qAll(indTpl)
    const indsWithTpl = indicators.map((i: any) => {
      const frozenTpl = (i.threshold_type !== undefined && i.threshold_type !== null && i.threshold_type !== '') ? {
        _key: i.template_id, indicator_name: i.indicator_name || '',
        threshold_type: i.threshold_type, yellow_threshold: i.yellow_threshold,
        red_threshold: i.red_threshold, sort_order: i.sort_order ?? 0,
      } : null
      const liveTpl = allIndTpls.find((t: any) => t._key === i.template_id) || null
      return { ...i, template: frozenTpl || liveTpl }
    })
    Logger.info(`[DCP] getReviewDetail building response`)
    const _rvEffState = getEffectiveState(rv)
    const _currentRoundNo = (rv as any).round_no || 1
    const evidenceContext = getEvidenceEditContext(rv)
    // 整改关联工作项
    const remediationIssues = issues.filter((v: any) => v.link_type === 'remediation')
    const remediationSummary = summarizeRemediation(remediationIssues)
    const remediationAllDone = remediationSummary.state === 'done'
    // 兼容旧数据：issue_status='done' 还原为「已完成」
    const issuesNormalized = issues.map((v: any) => ({ ...v, issue_status: normalizeIssueStatus(v.issue_status) }))
    const remediationIssuesNormalized = issuesNormalized.filter((v: any) => v.link_type === 'remediation')
    return { body: {
      review: { ...rvWithPhase, effective_state: _rvEffState, round_no: _currentRoundNo },
      materials: matsWithTpl,
      indicators: indsWithTpl,
      reviewers,
      linked_issues: issuesNormalized,
      remediation_issues: remediationIssuesNormalized,
      remediation_all_done: remediationAllDone,
      remediation_status_state: remediationSummary.state,
      remediation_unknown_count: remediationSummary.unknownCount,
      resolution: resList.find((r: any) => (r.round_no || 1) === _currentRoundNo) || null,
      resolutions: resList.sort((a: any, b: any) => (a.round_no || 1) - (b.round_no || 1)),
      supplements: supps.sort((a: any, b: any) => (b.submitted_at || 0) - (a.submitted_at || 0)),
      checklist: jsonArr((rv as any).checklist_json || '[]'),
      state_history: jsonArr((rv as any).state_history_json || '[]'),
      available_transitions: _rvEffState === 'remediation_pending' ? ['re_reviewing'] : [],
      can_edit_evidence: evidenceContext.editable,
      evidence_frozen: evidenceContext.frozen,
      evidence_target_round: evidenceContext.targetRound,
    }}
  } catch (e: any) {
    // ONES SDK 异常可能不是标准 Error，把完整对象序列化用于诊断
    let errDetail = ''
    try {
      if (e instanceof Error) {
        errDetail = e.message
      } else if (typeof e === 'string') {
        errDetail = e
      } else {
        errDetail = JSON.stringify(e)
      }
    } catch { errDetail = String(e) }
    Logger.error(`[DCP] getReviewDetail error: ${errDetail}`, e?.stack || '')
    return { body: { error: `加载详情失败: ${errDetail}` }, statusCode: 500 }
  }
}

// ============================================================
// 按项目列出评审单
// ============================================================
export async function listReviewsByProject(req: any): Promise<PluginResponse> {
  const puid = getParam(req, 'project_uuid')
  const rvType = getParam(req, 'review_type') || ''
  if (!puid) return { body: { error: '缺少 project_uuid' }, statusCode: 400 }
  let projectIdentity: CanonicalProjectIdentity
  try {
    projectIdentity = await resolveCanonicalProjectIdentity(req, puid)
  } catch (e: any) {
    return { body: { code: 'PROJECT_IDENTITY_UNAVAILABLE', error: e?.message || '无法确定项目身份' }, statusCode: 503 }
  }
  const projectLookupIds = projectIdentity.lookupIds
  const rvs = await qAll(review, (v: any) =>
    projectLookupIds.has(String(v.project_uuid || '')) &&
    (!rvType || normalizeReviewType(v.review_type) === normalizeReviewType(rvType)),
  )
  // 补充阶段名称映射
  const allPhases = await qAll(phaseTpl)
  const phMap = new Map(allPhases.map((p: any) => [p.phase_code, p.phase_name]))
  // 预加载角色模板（用于决议条件判断）
  const allRoleTpls = await qAll(roleTpl)
  // 预加载决议规则（按 review_type）
  const ruleCache: Record<string, any> = {}
  const enriched = await Promise.all(rvs.map(async (r: any) => {
    const reviewers = await qAll(rvReviewer, (v: any) => v.review_uuid === r.review_uuid)
    const submitted = reviewers.filter((rvr: any) => rvr.submitted_at > 0).length
    const issues = await qAll(linkedIssue, (v: any) => v.review_uuid === r.review_uuid)
    const reviewsMats = await qAll(matItem, (v: any) => v.review_uuid === r.review_uuid)
    const matSubmitted = reviewsMats.filter((m: any) => !!m.file_data).length
    const resolutions = await qAll(resolution, (v: any) => v.review_uuid === r.review_uuid)
    const res = getLatestResolution(resolutions, (r as any).round_no || 1)
    const final_conclusion = res?.final_conclusion || ''

    // 决议状态展示字段
    let resolution_status = ''
    let resolution_label = ''
    let resolution_pending = false
    if (res) {
      resolution_status = 'published'
      resolution_label = conclusionLabel(res.final_conclusion)
    } else if (r.status === 'draft') {
      resolution_status = 'not_started'
      resolution_label = '未发起'
    } else if (r.status === 'reviewing') {
      const rType = r.review_type || 'dcp'
      if (!ruleCache[rType]) ruleCache[rType] = await getResolutionRuleByType(rType)
      const rule = ruleCache[rType]
      const roleTpls = filterRolesByType(allRoleTpls, rType)
      const ready = isResolutionReady(rule, reviewers, roleTpls)
      resolution_pending = ready
      resolution_status = ready ? 'pending' : 'reviewing'
      resolution_label = ready ? '待决议' : '评审中'
    } else {
      resolution_status = 'missing'
      resolution_label = '未记录'
    }

    return {
      ...r,
      effective_state: getEffectiveState(r),
      phase_name: phMap.get(r.phase_code) || '',
      reviewer_total: reviewers.length,
      reviewer_done: submitted,
      linked_issue_count: issues.length,
      material_total: reviewsMats.length,
      material_submitted: matSubmitted,
      final_conclusion,
      resolution_status,
      resolution_label,
      resolution_pending,
      resolution_published_at: res?.published_at || 0,
      resolution_published_by_name: res?.published_by_name || '',
    }
  }))
  enriched.sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
  // 前端提示与后端发起校验共用“已完成闭环且本轮通过”的口径，并按评审类型隔离。
  const [passedDcp, passedTr] = await Promise.all([
    getClosedPassingPhases(projectLookupIds, 'dcp'),
    getClosedPassingPhases(projectLookupIds, 'tr'),
  ])
  const passedPhasesByType = { dcp: [...passedDcp], tr: [...passedTr] }
  const passedPhases = rvType
    ? passedPhasesByType[normalizeReviewType(rvType) as 'dcp' | 'tr']
    : [...new Set([...passedPhasesByType.dcp, ...passedPhasesByType.tr])]
  return { body: { reviews: enriched, passedPhases, passedPhasesByType } }
}

// ============================================================
// 团队全部评审（总览用）
// ============================================================
export async function listTeamReviews(req: any): Promise<PluginResponse> {
  const rvs = await qAll(review)
  const allPhases = await qAll(phaseTpl)
  const phMap = new Map(allPhases.map((p: any) => [p.phase_code, p.phase_name]))
  
  // 提取 team_uuid（多种兜底）
  let tuid = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || ''
  if (!tuid) {
    // ONES external API 路径为 /project/api/project/team/{uuid}/dcp/...
    const fullUrl = req.url || req.path || req.originalUrl || ''
    const m = fullUrl.match(/\/team\/([A-Za-z0-9_-]+)/)
    if (m) tuid = m[1]
  }
  if (!tuid) {
    // 尝试从查询参数取
    tuid = (req.query || {}).team_uuid || (req.query || {}).teamUUID || ''
  }
  // 🔍 诊断日志（排查 getParam 为何失败，确认修复后可移除）
  if (!tuid) {
    Logger.info('[WARN][listTeamReviews] team_uuid 提取失败', JSON.stringify({
      url: req.url,
      path: req.path,
      params: JSON.stringify(req.params || {}),
      query: JSON.stringify(req.query || {}),
    }))
  }
  
  // 批量解析项目元数据
  const projectKeys = [...new Set(rvs.map((r: any) => r.project_uuid).filter(Boolean))] as string[]
  const projectMetaMap: Record<string, any> = {}
  if (tuid && projectKeys.length > 0) {
    Logger.info(`[listTeamReviews] 解析 ${projectKeys.length} 个项目元数据, team=${tuid}`)
    await Promise.all(projectKeys.map(async (key) => {
      projectMetaMap[key] = await resolveProjectMeta(tuid, key)
    }))
  } else if (projectKeys.length > 0) {
    Logger.info(`[WARN][listTeamReviews] 跳过项目元数据解析: tuid=${JSON.stringify(tuid)}, projectKeys=${JSON.stringify(projectKeys)}`)
  }
  
  let total = 0, reviewing = 0, completed = 0, linkedTotal = 0
  const enriched = await Promise.all(rvs.map(async (r: any) => {
    total++
    if (r.status === 'reviewing') reviewing++
    if (r.status === 'completed' || r.status === 'rejected') completed++
    const reviewers = await qAll(rvReviewer, (v: any) => v.review_uuid === r.review_uuid)
    const submitted = reviewers.filter((rvr: any) => rvr.submitted_at > 0).length
    const issues = await qAll(linkedIssue, (v: any) => v.review_uuid === r.review_uuid)
    linkedTotal += issues.length
    const reviewsMats = await qAll(matItem, (v: any) => v.review_uuid === r.review_uuid)
    const matSubmitted = reviewsMats.filter((m: any) => !!m.file_data).length
    const meta = projectMetaMap[r.project_uuid] || {}
    return {
      ...r,
      effective_state: getEffectiveState(r),
      project_identifier: meta.project_identifier || r.project_uuid,
      project_real_uuid: meta.project_real_uuid || '',
      project_name: meta.project_name || r.project_uuid,
      review_type: r.review_type || 'dcp',
      phase_name: phMap.get(r.phase_code) || '',
      reviewer_total: reviewers.length,
      reviewer_done: submitted,
      reviewer_uuids: reviewers.map((rvr: any) => rvr.reviewer_uuid).filter(Boolean),
      linked_issue_count: issues.length,
      material_total: reviewsMats.length,
      material_submitted: matSubmitted,
    }
  }))
  enriched.sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0))
  return { body: {
    reviews: enriched,
    stats: { total, reviewing_count: reviewing, completed_count: completed, linked_issue_count: linkedTotal },
  }}
}

// ============================================================
// 评审统计 API — 三个维度聚合数据
// ============================================================
export async function getDcpStats(req: any): Promise<PluginResponse> {
  const tuid = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || (() => {
    const fullUrl = req.url || req.path || ''
    const m = fullUrl.match(/\/team\/([A-Za-z0-9_-]+)/)
    return m ? m[1] : ''
  })()
  // 从 query string 解析时间范围
  const startDate = getParam(req, 'start_date') || ''
  const endDate = getParam(req, 'end_date') || ''
  let startTs = 0
  let endTs = 0
  if (startDate) { startTs = new Date(startDate + 'T00:00:00').getTime() }
  if (endDate) { endTs = new Date(endDate + 'T23:59:59').getTime() }

  // 加载全部数据
  const allReviews = await qAll(review)
  const allReviewers = await qAll(rvReviewer)
  const allResolutions = await qAll(resolution)
  const allPhases = await qAll(phaseTpl)
  const phMap = new Map(allPhases.map((p: any) => [p.phase_code, p.phase_name]))

  // 评审人用户名由前端解析（OPFetch 从插件后端调 ONES 内部 API 404）
  // 前端 fetch /project/api/project/team/{uuid}/members 可成功获取

  // 按时间过滤
  const filteredReviews = allReviews.filter((r: any) => {
    const ts = r.created_at || 0
    if (startTs && ts < startTs) return false
    if (endTs && ts > endTs) return false
    return true
  })

  // 构建决议查找索引：review_uuid → resolutions[]
  const resByReview = new Map<string, any[]>()
  for (const res of allResolutions) {
    const arr = resByReview.get(res.review_uuid) || []
    arr.push(res)
    resByReview.set(res.review_uuid, arr)
  }

  // 构建评审人查找索引：review_uuid → reviewers[]
  const rvrsByReview = new Map<string, any[]>()
  for (const rvr of allReviewers) {
    const arr = rvrsByReview.get(rvr.review_uuid) || []
    arr.push(rvr)
    rvrsByReview.set(rvr.review_uuid, arr)
  }

  // ==================== 报表一：评审趋势统计 ====================
  let total = filteredReviews.length
  let reviewing = 0, completed = 0, rejected = 0, draft = 0
  const statusTrend: Record<string, number> = {}
  const typeTrend: Record<string, number> = { dcp: 0, tr: 0 }
  const phaseTrend: Record<string, number> = {}
  const weeklyTrend: Record<string, number> = {}

  // 计算日期所在 ISO 周的 key（YYYY-Www）
  function getWeekKey(d: Date): string {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const dayNum = date.getDay() || 7 // 周日=7
    date.setDate(date.getDate() - dayNum + 1) // 回到本周周一
    const yearStart = new Date(date.getFullYear(), 0, 1)
    const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
  }

  for (const r of filteredReviews) {
    const st = r.status || 'draft'
    if (st === 'reviewing') reviewing++
    else if (st === 'completed') completed++
    else if (st === 'rejected') rejected++
    else draft++
    statusTrend[st] = (statusTrend[st] || 0) + 1

    const rt = r.review_type || 'dcp'
    typeTrend[rt] = (typeTrend[rt] || 0) + 1

    const pc = r.phase_code || '未知'
    phaseTrend[pc] = (phaseTrend[pc] || 0) + 1

    // 按周统计
    const d = new Date(r.created_at || 0)
    if (d.getTime() > 0) {
      const wk = getWeekKey(d)
      weeklyTrend[wk] = (weeklyTrend[wk] || 0) + 1
    }
  }

  // 补全空周：生成时间范围内所有自然周序列
  const weeklyList: { week: string; count: number }[] = []
  if (Object.keys(weeklyTrend).length > 0) {
    let startD: Date
    let endD: Date
    if (startTs && endTs) {
      startD = new Date(startTs)
      endD = new Date(endTs)
    } else {
      const allKeys = Object.keys(weeklyTrend).sort()
      const first = allKeys[0].split('-W')
      startD = new Date(parseInt(first[0]), 0, 1)
      const last = allKeys[allKeys.length - 1].split('-W')
      endD = new Date(parseInt(last[0]), 11, 31)
    }
    const cursor = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate())
    const dayNum = cursor.getDay() || 7
    cursor.setDate(cursor.getDate() - dayNum + 1) // 对齐到周一
    while (cursor <= endD) {
      const wk = getWeekKey(cursor)
      weeklyList.push({ week: wk, count: weeklyTrend[wk] || 0 })
      cursor.setDate(cursor.getDate() + 7)
    }
  }

  // ==================== 报表二：评审人参与统计 ====================
  // 按 reviewer_uuid 聚合，只统计时间范围内的评审
  const reviewerStats = new Map<string, {
    reviewer_uuid: string; reviewer_name: string; roles: Set<string>
    total_participated: number; first_round_pass: number; first_round_reject: number
    first_round_total: number; submitted_count: number
  }>()

  for (const r of filteredReviews) {
    const reviewers = rvrsByReview.get(r.review_uuid) || []
    for (const rvr of reviewers) {
      const uid = rvr.reviewer_uuid || ''
      if (!uid) continue
      let st = reviewerStats.get(uid)
      if (!st) {
        st = {
          reviewer_uuid: uid, reviewer_name: rvr.reviewer_name || uid,
          roles: new Set(), total_participated: 0, first_round_pass: 0,
          first_round_reject: 0, first_round_total: 0, submitted_count: 0,
        }
        reviewerStats.set(uid, st)
      }
      st.total_participated++
      if (rvr.role_name) st.roles.add(rvr.role_name)
      if (rvr.submitted_at > 0) st.submitted_count++
      // 首轮通过率：只看 round_no=1 且已提交的投票
      const roundNo = rvr.round_no || 1
      if (roundNo === 1 && rvr.submitted_at > 0) {
        st.first_round_total++  // 分母=首轮已提交数
        const c = rvr.conclusion || ''
        if (c === 'pass' || c === 'conditional_pass') st.first_round_pass++
        if (c === 'reject' || c === 'fail') st.first_round_reject++
      }
    }
  }

  const reviewerList = Array.from(reviewerStats.values()).map((s: any) => ({
    reviewer_uuid: s.reviewer_uuid,
    reviewer_name: s.reviewer_name || s.reviewer_uuid,
    roles: Array.from(s.roles),
    total_participated: s.total_participated,
    submitted_count: s.submitted_count,
    first_round_pass: s.first_round_pass,
    first_round_reject: s.first_round_reject,
    first_round_total: s.first_round_total,
    first_round_pass_rate: s.submitted_count > 0
      ? Math.round(s.first_round_pass / s.submitted_count * 100) : 0,
    reject_rate: s.submitted_count > 0
      ? Math.round(s.first_round_reject / s.submitted_count * 100) : 0,
  })).sort((a: any, b: any) => b.total_participated - a.total_participated)

  const totalReviewers = reviewerList.length

  // ==================== 报表三：项目维度统计 ====================
  const projectMap = new Map<string, { project_uuid: string; total: number; completed: number; passed: number }>()

  for (const r of filteredReviews) {
    const pkey = r.project_uuid || '未知'
    let ps = projectMap.get(pkey)
    if (!ps) { ps = { project_uuid: pkey, total: 0, completed: 0, passed: 0 }; projectMap.set(pkey, ps) }
    ps.total++
    if (r.status === 'completed' || r.status === 'rejected') ps.completed++
    // 检查是否有 pass/conditional_pass 决议
    const resolutions = resByReview.get(r.review_uuid) || []
    const passed = resolutions.some((res: any) =>
      res.final_conclusion === 'pass' || res.final_conclusion === 'conditional_pass'
    )
    if (passed) ps.passed++
  }

  // 解析项目名称
  const projectKeys = Array.from(projectMap.keys())
  const projectMetaMap: Record<string, any> = {}
  if (tuid && projectKeys.length > 0) {
    await Promise.all(projectKeys.map(async (key) => {
      projectMetaMap[key] = await resolveProjectMeta(tuid, key)
    }))
  }

  const projectList = Array.from(projectMap.values()).map((ps) => ({
    ...ps,
    project_name: projectMetaMap[ps.project_uuid]?.project_name || ps.project_uuid,
    project_identifier: projectMetaMap[ps.project_uuid]?.project_identifier || ps.project_uuid,
    pass_rate: ps.completed > 0 ? Math.round(ps.passed / ps.completed * 100) : 0,
  })).sort((a: any, b: any) => b.total - a.total)

  return { body: {
    // 报表一：评审趋势统计
    trend: {
      total, reviewing, completed, rejected, draft,
      status_trend: statusTrend,
      type_trend: typeTrend,
      phase_trend: Object.entries(phaseTrend).map(([code, count]) => ({
        phase_code: code, phase_name: phMap.get(code) || code, count,
      })).sort((a: any, b: any) => b.count - a.count),
      weekly_trend: weeklyList,
    },
    // 报表二：评审人参与统计
    reviewers: {
      total: totalReviewers,
      list: reviewerList,
    },
    // 报表三：项目维度统计
    projects: {
      list: projectList,
    },
    // 时间范围
    time_range: { start_date: startDate, end_date: endDate },
  }}
}

// ============================================================
// 我的评审（按评审人 UUID 筛选待办/已办）
// ============================================================
export async function listMyReviews(req: any): Promise<PluginResponse> {
  // 始终使用网关注入的当前用户，忽略 query/body 中可伪造的 reviewer_uuid。
  const reviewerUuid = getOperator(req)
  if (!reviewerUuid) {
    return { body: { code: 'AUTHENTICATION_REQUIRED', error: '无法确认当前登录用户身份' }, statusCode: 401 }
  }
  const allRvs = await qAll(review)
  const allPhases = await qAll(phaseTpl)
  const phMap = new Map(allPhases.map((p: any) => [p.phase_code, p.phase_name]))

  // 提取 team_uuid 用于解析项目名称
  let tuid = getParam(req, 'team_uuid') || getParam(req, 'teamUUID') || ''
  if (!tuid) {
    const fullUrl = req.url || req.path || req.originalUrl || ''
    const m = fullUrl.match(/\/team\/([A-Za-z0-9_-]+)/)
    if (m) tuid = m[1]
  }

  // 批量解析项目元数据
  const projectKeys = [...new Set(allRvs.map((r: any) => r.project_uuid).filter(Boolean))] as string[]
  const projectMetaMap: Record<string, any> = {}
  if (tuid && projectKeys.length > 0) {
    await Promise.all(projectKeys.map(async (key) => {
      try { projectMetaMap[key] = await resolveProjectMeta(tuid, key) } catch {}
    }))
  }

  // 预加载决议规则配置（避免循环内重复查询）
  const resRules = await getResolutionRuleConfig()

  const results: any[] = []
  for (const r of allRvs) {
    if (r.status !== 'reviewing' && r.status !== 'completed' && r.status !== 'rejected') continue
    // 优先从实体查询评审人，兜底从 reviewers_json 快照读取
    let rvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === r.review_uuid)
    if (rvrs.length === 0) {
      const snap = jsonArr((r as any).reviewers_json || '[]')
      rvrs = snap.map((s: any) => s._key ? s : { ...s, _key: `${r.review_uuid}_snap_${Math.random().toString(36).slice(2, 6)}` })
    }
    const my = rvrs.find((v: any) => v.reviewer_uuid === reviewerUuid)
    if (!my) continue
    // 按 round_no 判断是否已提交当前轮次（旧数据 round_no 缺失时视为 1）
    const reviewRoundNo = (r as any).round_no || 1
    const myRoundNo = (my as any).round_no || 1
    const mySubmittedCurrentRound = my.submitted_at > 0 && myRoundNo === reviewRoundNo
    const issues = await qAll(linkedIssue, (v: any) => v.review_uuid === r.review_uuid)
    const allResolutions = await qAll(resolution, (v: any) => v.review_uuid === r.review_uuid)
    const hasResolution = allResolutions.some((res: any) => (res.round_no || 1) === reviewRoundNo)
    const rvType = (r as any).review_type || 'dcp'
    const rule = resRules[rvType] || {}
    const publisherRole = getPublisherRole(rule)
    const isPublisher = publisherRole && my.role_name === publisherRole
    // 按 submitRequirement 判断是否满足决议条件
    const allRoleTpls = await getRoleTemplatesForReview(r)
    // 投影到当前轮次：旧轮次的提交数据视为未提交（与 getReviewDetail/submitOpinion 保持一致）
    const _listRoundNo = (r as any).round_no || 1
    const rvrsProjected = rvrs.map((rvr: any) => {
      if ((rvr.round_no || 1) !== _listRoundNo) {
        return { ...rvr, submitted_at: 0, conclusion: '', risk_level: '', opinion_summary: '', round_no: _listRoundNo }
      }
      return rvr
    })
    const resolutionReady = isResolutionReady(rule, rvrsProjected, allRoleTpls)
    const isResolutionPending = !!(isPublisher && resolutionReady && !hasResolution && r.status === 'reviewing')
    const meta = projectMetaMap[r.project_uuid] || {}
    results.push({
      review_uuid: r.review_uuid,
      review_number: r.review_number || '',
      project_uuid: r.project_uuid,
      project_name: meta.project_name || r.project_uuid,
      phase_code: r.phase_code,
      phase_name: phMap.get(r.phase_code) || '',
      review_title: r.review_title,
      status: r.status,
      effective_state: getEffectiveState(r),
      review_type: r.review_type || 'dcp',
      meeting_time: r.meeting_time,
      created_at: r.created_at,
      reviewer_total: rvrs.length,
      reviewer_done: rvrs.filter((v: any) => v.submitted_at > 0).length,
      linked_issue_count: issues.length,
      my_role: my.role_name,
      my_submitted: mySubmittedCurrentRound,
      my_conclusion: mySubmittedCurrentRound ? (my.conclusion || '') : '',
      is_publisher: !!isPublisher,
      resolution_pending: isResolutionPending,
    })
  }
  results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  // 拆分三类：待我评审 / 待我决议 / 已完成
  // 决议人不进入"待我评审"；"待我决议"只在前置评审满足提交要求后出现
  // 使用 effective_state 做精确分类：reviewing/re_reviewing → 待评审；awaiting_resolution → 待决议
  const review_pending = results.filter(r => 
    (r.effective_state === 'reviewing' || r.effective_state === 're_reviewing') 
    && !r.my_submitted && !r.is_publisher
  )
  const resolution_pending = results.filter(r => r.resolution_pending)
  const done = results.filter(r => 
    r.my_submitted || r.status === 'completed' || r.status === 'rejected'
    || r.effective_state === 'remediation_pending'
    || r.effective_state === 'resolution_published'
  )
  return { body: { reviews: results, review_pending, resolution_pending, done, pending: review_pending } }
}

// ============================================================
// 发起评审（draft → reviewing）
// ============================================================
export async function startReview(req: any): Promise<PluginResponse> {
  try {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  let rv = await review.get(rid) as any
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  // 方案B：仅创建者可发起评审
  const _startOp = getOperator(req)
  if (_startOp && (rv as any).creator_uuid && _startOp !== (rv as any).creator_uuid) {
    return { body: { error: '仅创建者可发起评审' }, statusCode: 403 }
  }
  // canceled 兼容旧 status=draft，可通过本专用入口重新发起；不允许通过通用 transition 绕过这里的全部前置校验。
  if (rv.status !== 'draft') return { body: { error: '当前状态不可发起评审' }, statusCode: 400 }

  const reviewType = normalizeReviewType(rv.review_type)
  let projectIdentity: CanonicalProjectIdentity
  try {
    projectIdentity = await resolveCanonicalProjectIdentity(req, String(rv.project_uuid || ''))
  } catch (e: any) {
    return { body: { code: 'PROJECT_IDENTITY_UNAVAILABLE', error: e?.message || '无法确定项目身份' }, statusCode: 503 }
  }

  // 新评审单在创建时把阶段依赖写入决议规则快照；旧草稿在首次发起时补齐。
  let phaseSnapshot = getPhaseDependencySnapshot(rv)
  let frozenRuleJson = String(rv.resolution_rule_json || '')
  if (!phaseSnapshot) {
    let frozenRule: any
    try {
      frozenRule = await getResolutionRuleForReview(rv)
    } catch (e: any) {
      return { body: { code: 'REVIEW_CONFIG_SNAPSHOT_MISSING', error: e?.message || '评审配置快照缺失' }, statusCode: 409 }
    }
    const dependencies = await getPhaseDependencies(rv.phase_code, reviewType)
    phaseSnapshot = {
      canonicalProjectUuid: projectIdentity.canonicalUuid,
      projectIdentifier: projectIdentity.identifier,
      dependencies,
      capturedAt: Date.now(),
    }
    frozenRuleJson = JSON.stringify(withPhaseDependencySnapshot(
      frozenRule, projectIdentity, dependencies, phaseSnapshot.capturedAt,
    ))
  }
  const deps = phaseSnapshot.dependencies
  const identityOrSnapshotChanged =
    rv.project_uuid !== projectIdentity.canonicalUuid ||
    frozenRuleJson !== String(rv.resolution_rule_json || '')
  if (identityOrSnapshotChanged) {
    rv = cleanForSet({
      ...rv,
      project_uuid: projectIdentity.canonicalUuid,
      resolution_rule_json: frozenRuleJson,
    })
    await review.set(rid, rv)
  }

  // 历史重复草稿也必须在发起时拦截，不能依赖创建时校验。
  const phaseRows = await qAll(phaseTpl, (v: any) =>
    v.phase_code === rv.phase_code && normalizeReviewType(v.review_type) === reviewType,
  )
  const phaseName = phaseRows[0]?.phase_name || rv.phase_code
  const startConflict = await findPhaseReviewConflict(projectIdentity.lookupIds, rv.phase_code, reviewType, rid)
  if (startConflict) return phaseConflictResponse(startConflict, phaseName, reviewType)

  const claimedGuard = await claimPhaseGuard(projectIdentity.canonicalUuid, rv.phase_code, reviewType, rid)
  if (!claimedGuard.ok) {
    const guardConflict = await findPhaseReviewConflict(projectIdentity.lookupIds, rv.phase_code, reviewType, rid)
    if (guardConflict) return phaseConflictResponse(guardConflict, phaseName, reviewType)
    return { body: { code: 'REVIEW_PHASE_ALREADY_ACTIVE', error: '该项目阶段已被其他评审单占用，请刷新后重试' }, statusCode: 409 }
  }

  // 校验 0：前置阶段必须在同一规范项目、同一评审类型下完成闭环且本轮通过。
  if (deps.length) {
    const passedPhases = await getClosedPassingPhases(projectIdentity.lookupIds, reviewType)
    const unmet = deps.filter((d: string) => !passedPhases.has(d))
    if (unmet.length) {
      return {
        body: {
          code: 'PHASE_PREREQUISITES_NOT_SATISFIED',
          error: `前置阶段尚未完成通过闭环，无法发起评审: ${unmet.join(', ')}`,
          unmet_dependencies: unmet,
        },
        statusCode: 409,
      }
    }
  }

  // 校验 1：所有 must_vote 或 has_veto 角色都已指定评审人（使用固化角色模板）
  const snapReviewers = jsonArr((rv as any).reviewers_json || '[]')
  const entityReviewersStart = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  const reviewers = entityReviewersStart.length > 0 ? entityReviewersStart : snapReviewers
  if (reviewers.length === 0) {
    return { body: { error: '请先添加评审人' }, statusCode: 400 }
  }
  const roleTemplates = await getRoleTemplatesForReview(rv)
  const requiredRoles = roleTemplates.filter((rt: any) => rt.must_vote || rt.has_veto)
  const missingRoles: string[] = []
  for (const rt of requiredRoles) {
    const hasReviewer = reviewers.some((rvr: any) => rvr.role_name === rt.role_name)
    if (!hasReviewer) missingRoles.push(rt.role_name)
  }
  if (missingRoles.length > 0) {
    return { body: { error: `以下角色尚未指定评审人：${missingRoles.join('、')}` }, statusCode: 400 }
  }

  // 校验 1.2：决议角色必须已指定且唯一（使用固化规则）
  let _startRule: any
  try {
    _startRule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }
  const _publisherRole = getPublisherRole(_startRule)
  if (_publisherRole) {
    const publisherReviewers = reviewers.filter((rvr: any) => rvr.role_name === _publisherRole)
    if (publisherReviewers.length === 0) {
      return { body: { error: `决议角色「${_publisherRole}」必须指定 1 名评审人` }, statusCode: 400 }
    }
    if (publisherReviewers.length > 1) {
      return { body: { error: `决议角色「${_publisherRole}」只能指定 1 名评审人` }, statusCode: 400 }
    }
  } else {
    return { body: { error: `${reviewType.toUpperCase()} 决议角色未配置，请先在插件配置中设置。` }, statusCode: 400 }
  }

  // 校验 1.5：决议规则可达性校验——按实际评审人检查 minCount 是否可达
  const _rule = _startRule
  if (_rule.passRule?.mode === 'min_approval_count' && _rule.allowedConclusions?.includes('pass')) {
    const scopeNames = resolveVoteScopeRoleNames(_rule, roleTemplates)
    const actualCandidates = reviewers.filter((r: any) => scopeNames.includes(r.role_name))
    const minCount = Number(_rule.passRule.minCount || 0)
    if (actualCandidates.length < minCount) {
      return { body: { error: `当前评审单可计票评审人只有 ${actualCandidates.length} 人，但决议规则要求至少 ${minCount} 人通过。请补充评审人或调整决议规则。` }, statusCode: 400 }
    }
  }

  // 校验 2：必填交付物必须已上传文件（使用固化 required 字段，兜底实时模板）
  const materials = await qAll(matItem, (v: any) => v.review_uuid === rid)
  const requiredMats: any[] = []
  for (const m of materials) {
    if (await getMaterialRequired(m)) requiredMats.push(m)
  }
  const unsubmittedRequired = requiredMats.filter((m: any) => !m.file_data)
  if (unsubmittedRequired.length > 0) {
    const names: string[] = []
    for (const m of unsubmittedRequired) {
      names.push(await getMaterialName(m))
    }
    return { body: { error: `以下必填评审资料尚未上传：${names.join('、')}` }, statusCode: 400 }
  }

  // 校验 3：关键指标不能有红色（超出红线阈值）
  const indicators = await qAll(indData, (v: any) => v.review_uuid === rid)
  const redIndicators = indicators.filter((ind: any) => ind.risk_color === 'red')
  if (redIndicators.length > 0) {
    const names: string[] = []
    for (const ind of redIndicators) {
      const cfg = await getIndicatorThreshold(ind)
      names.push(cfg?.indicator_name || ind.template_id)
    }
    return { body: { error: `以下关键指标已超出红线阈值，请修正后再发起评审：${names.join('、')}` }, statusCode: 400 }
  }

  // 初始化 checklist：从固化模板复制到 review.checklist_json（兜底实时模板）
  const phaseItems = await getChecklistTemplatesForReview(rv)
  let checklistJson = (rv as any).checklist_json || '[]'
  if (phaseItems.length > 0) {
    const initList = phaseItems.map((item: any) => ({
      template_id: item.template_id || item._key,
      role_name: item.role_name,
      item_text: item.item_text,
      sort_order: item.sort_order,
      status: 'unchecked',
      checked_by: '',
      checked_at: 0,
    }))
    checklistJson = JSON.stringify(initList)
  }
  // 提交状态前再次检查冲突和 guard，缩小并发创建/发起的竞争窗口。
  const finalConflict = await findPhaseReviewConflict(projectIdentity.lookupIds, rv.phase_code, reviewType, rid)
  if (finalConflict) return phaseConflictResponse(finalConflict, phaseName, reviewType)
  const confirmedGuard = await phaseGuard.get(phaseGuardKey(projectIdentity.canonicalUuid, rv.phase_code, reviewType)) as any
  if (confirmedGuard?.guard_state !== 'active' || confirmedGuard?.review_uuid !== rid) {
    return { body: { code: 'REVIEW_PHASE_GUARD_LOST', error: '阶段占用状态已变化，请刷新后重试' }, statusCode: 409 }
  }

  const opUuid = getOperator(req)
  const stateFields = buildStateTransition(rv, 'reviewing', opUuid, '发起评审', { checklist_json: checklistJson })
  await review.set(rid, cleanForSet({ ...rv, ...stateFields }))
  await writeAudit(rid, opUuid, '启动评审', rid,
    `评审已发起，共 ${reviewers.length} 名评审人`)

  // 通知评审人（非阻塞）
  const notCfg = await getNotifyConfig()
  if (notCfg.enabled && notCfg.on_review_start) {
    const uuids = reviewers.map((r: any) => r.reviewer_uuid).filter(Boolean)
    if (uuids.length > 0) {
      const phaseName = (rv as any).phase_code || ''
      const reviewTitle = (rv as any).review_title || 'DCP评审'
      await sendNotification(
        `DCP评审通知 — ${phaseName}`,
        `您被指定为「${phaseName} ${reviewTitle}」的评审人，请前往评审工作台提交评审意见。`,
        `${(rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : ''}`,
        uuids,
      )
    }
  }

  return { body: { ok: true, status: 'reviewing', review_state: 'reviewing' } }
  } catch (e: any) {
    let errDetail: string
    try {
      if (e instanceof Error) errDetail = e.message
      else if (typeof e === 'string') errDetail = e
      else errDetail = JSON.stringify(e, Object.getOwnPropertyNames(e))
    } catch { errDetail = String(e) }
    Logger.error(`[DCP] startReview error: ${errDetail}`, e?.stack || '')
    return { body: { error: `发起评审失败: ${errDetail}` }, statusCode: 500 }
  }
}

// ============================================================
// 撤回评审（reviewing → draft）
// ============================================================
export async function recallReview(req: any): Promise<PluginResponse> {
 try {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const operator_uuid = getOperator(req)
  const { reason } = b

  if (!rid || !operator_uuid) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  const cfg = await getReviewRecallConfig()
  if (!cfg.enabled) {
    return { body: { error: '管理员未开启评审撤回功能' }, statusCode: 403 }
  }

  if (rv.status !== 'reviewing') {
    return { body: { error: '仅评审中的评审单可以撤回' }, statusCode: 400 }
  }
  // 精确状态校验：reviewing / awaiting_resolution 可撤回
  const _recallEffState = getEffectiveState(rv)
  if (_recallEffState !== 'reviewing' && _recallEffState !== 'awaiting_resolution') {
    return { body: { error: '当前状态不可撤回' }, statusCode: 400 }
  }

  if (rv.creator_uuid !== operator_uuid) {
    return { body: { error: '仅评审发起人可以撤回评审' }, statusCode: 403 }
  }

  // 仅检查当前轮次是否有决议（多轮复审时旧轮次的决议不阻止撤回）
  const _recallRoundNo = (rv as any).round_no || 1
  const _recallAllRes = await qAll(resolution, (v: any) => v.review_uuid === rid)
  const hasResolution = _recallAllRes.some((res: any) => (res.round_no || 1) === _recallRoundNo)
  if (hasResolution) {
    return { body: { error: '评审已发布决议，不可撤回' }, statusCode: 400 }
  }

  if (cfg.requireReason && !String(reason || '').trim()) {
    return { body: { error: '请填写撤回原因' }, statusCode: 400 }
  }

  const now = Date.now()

  // 重置评审人提交状态
  const allReviewers = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  const resetReviewers: any[] = []
  for (const r of allReviewers) {
    const { _key, ...rest } = r
    const reset = {
      ...rest,
      conclusion: '',
      risk_level: 'medium',
      opinion_summary: '',
      submitted_at: 0,
    }
    await rvReviewer.set(r._key, reset)
    resetReviewers.push({ _key: r._key, ...reset })
  }

  // 重置 checklist
  let checklistJson = (rv as any).checklist_json || '[]'
  try {
    const cl = jsonArr(checklistJson)
    for (const item of cl) {
      item.status = 'unchecked'
      item.checked_by = ''
      item.checked_at = 0
    }
    checklistJson = JSON.stringify(cl)
  } catch { /* ignore */ }

  // 回到 draft 状态，清空决议通知状态
  const stateFields = buildStateTransition(rv, 'canceled', operator_uuid, `撤回评审：${reason || '未填写'}`, {
    checklist_json: checklistJson,
    reviewers_json: JSON.stringify(resetReviewers),
  })
  // canceled 的兼容 status = draft
  await review.set(rid, cleanForSet({ ...rv, ...stateFields }))
  await releasePhaseGuard({ ...rv, review_uuid: rid })

  await writeAudit(rid, operator_uuid, '撤回评审', rid,
    `评审已撤回，回到草稿状态。原因：${reason || '未填写'}`)

  return { body: { ok: true, status: 'draft', review_state: 'canceled' } }
 } catch (e: any) {
   let errDetail = ''
   try {
     if (e instanceof Error) errDetail = e.message
     else if (typeof e === 'string') errDetail = e
     else errDetail = JSON.stringify(e)
   } catch { errDetail = String(e) }
   Logger.error(`[DCP] recallReview error: ${errDetail}`, e?.stack || '')
   return { body: { error: `撤回失败: ${errDetail}` }, statusCode: 500 }
 }
}

// ============================================================
// 更新评审单基础信息（会议时间等）
// ============================================================
export async function updateReviewBasicInfo(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const operator_uuid = getOperator(req)
  const { meeting_time, review_title } = b

  if (!rid || !operator_uuid) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  if (rv.creator_uuid !== operator_uuid) {
    return { body: { error: '仅评审发起人可以修改会议时间' }, statusCode: 403 }
  }

  if (rv.status !== 'draft' && rv.status !== 'reviewing') {
    return { body: { error: '当前状态不可修改会议时间' }, statusCode: 400 }
  }

  const _ubInfoRoundNo = (rv as any).round_no || 1
  const _ubInfoAllRes = await qAll(resolution, (v: any) => v.review_uuid === rid)
  const hasResolution = _ubInfoAllRes.some((res: any) => (res.round_no || 1) === _ubInfoRoundNo)
  if (hasResolution) {
    return { body: { error: '评审已发布决议，不可修改会议时间' }, statusCode: 400 }
  }

  const next: any = {
    ...rv,
    meeting_time: Number(meeting_time || 0),
    updated_at: Date.now(),
  }

  if (typeof review_title === 'string') {
    next.review_title = review_title.trim() || rv.review_title
  }

  await review.set(rid, cleanForSet(next))

  await writeAudit(rid, operator_uuid, '修改会议时间', rid,
    `会议时间修改为: ${next.meeting_time ? new Date(next.meeting_time).toLocaleString('zh-CN') : '未设置'}`)

  return { body: { ok: true, review: next } }
}

// ============================================================
// 材料文件上传
// ============================================================
export async function uploadMaterialFile(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  const { template_id, file_name, object_key } = b
  // 方案A：用真实身份记录上传者
  const _uploadOp = getOperator(req)
  if (!rid || !template_id || !file_name) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const evidenceContext = getEvidenceEditContext(rv)
  const denied = evidenceEditDenied(evidenceContext)
  if (denied) return denied
  const key = `${rid}_mat_${template_id}`
  const ex = (await matItem.get(key)) as any
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  const now = Date.now()

  // 整改期间追加：旧当前文件推入 attachments_json，新文件成为当前版
  let attachments = jsonArr((ex as any).attachments_json || '[]')
  if (evidenceContext.state === 'remediation_pending' && ex.file_data) {
    attachments.push({
      file_name: ex.file_name || '',
      file_data: ex.file_data || '',
      object_key: ex.file_data || '',
      file_size: Number(ex.file_size || 0),
      uploaded_by: ex.updated_by || '',
      uploaded_at: Number(ex.uploaded_at || 0),
      round_no: Number(ex.round_no || 1),
      replaced_at: now,
      replaced_in_round: evidenceContext.targetRound,
    })
  }

  await matItem.set(key, {
    review_uuid: rid, template_id,
    submit_status: (ex.submit_status === 'approved' || ex.submit_status === 'rejected') ? ex.submit_status : 'submitted',
    notes: ex.notes ?? '',
    updated_by: _uploadOp || b.updated_by || '', updated_at: now,
    file_name, file_data: object_key || ex.file_data || '', file_size: b.file_size || 0,
    uploaded_at: now,
    round_no: evidenceContext.targetRound,
    // 保留固化字段
    material_name: ex.material_name || '', required: ex.required ?? 0,
    responsible_role: ex.responsible_role || '', sort_order: ex.sort_order ?? 0,
    // 历史附件（整改追加的旧文件）
    attachments_json: JSON.stringify(attachments),
  })
  const auditAction = evidenceContext.state === 'remediation_pending' && ex.file_data ? '整改材料追加' : '上传材料'
  await writeAudit(rid, _uploadOp || b.operator_uuid || b.updated_by || '', auditAction, template_id,
    `${auditAction}: ${file_name}`)
  return { body: { ok: true, file_name } }
}

// ============================================================
// 清除材料文件（仅草稿状态可操作）
// ============================================================
export async function removeMaterialFile(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const _removeOp = getOperator(req)
  const { template_id } = b
  if (!rid || !template_id) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const evidenceContext = getEvidenceEditContext(rv)
  const denied = evidenceEditDenied(evidenceContext)
  if (denied) return denied
  const key = `${rid}_mat_${template_id}`
  const ex = (await matItem.get(key)) as any
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  let attachments = jsonArr(ex.attachments_json || '[]')
  if (evidenceContext.state === 'remediation_pending' && ex.file_data) {
    attachments.push({
      file_name: ex.file_name || '',
      file_data: ex.file_data || '',
      object_key: ex.file_data || '',
      file_size: Number(ex.file_size || 0),
      uploaded_by: ex.updated_by || '',
      uploaded_at: Number(ex.uploaded_at || 0),
      round_no: Number(ex.round_no || 1),
      replaced_at: Date.now(),
      replaced_in_round: evidenceContext.targetRound,
    })
  }
  await matItem.set(key, {
    review_uuid: rid, template_id,
    submit_status: 'draft',
    notes: ex.notes ?? '',
    updated_by: _removeOp || b.updated_by || '', updated_at: Date.now(),
    file_name: '', file_data: '', file_size: 0,
    uploaded_at: 0,
    round_no: evidenceContext.targetRound,
    // 保留固化字段
    material_name: ex.material_name || '', required: ex.required ?? 0,
    responsible_role: ex.responsible_role || '', sort_order: ex.sort_order ?? 0,
    attachments_json: evidenceContext.state === 'remediation_pending' ? JSON.stringify(attachments) : '[]',
  })
  await writeAudit(rid, _removeOp || b.operator_uuid || b.updated_by || '', '删除材料', template_id,
    `清除材料文件`)
  return { body: { ok: true } }
}

// ============================================================
// 获取材料上传预签名 URL（对象存储）
// ============================================================
export async function getMaterialUploadUrl(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const tid = getParam(req, 'template_id')
  if (!rid || !tid) return { body: { error: '缺少必要字段' }, statusCode: 400 }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const denied = evidenceEditDenied(getEvidenceEditContext(rv))
  if (denied) return denied
  // 检查材料项存在
  const key = `${rid}_mat_${tid}`
  const ex = await matItem.get(key)
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  // 生成对象存储 key（ONES 对象存储不支持 / 路径分隔符）
  const ts = Date.now()
  const objKey = `dcp_files-${rid}-${tid}-${ts}`
  const { object } = storage
  const result = await object.upload(objKey) as any
  if (result?.code) {
    // ObjectError
    return { body: { error: `获取上传地址失败: ${result.message || result.code}` }, statusCode: 500 }
  }
  return { body: {
    url: result.getWebUrl(),
    fields: result.getFields(),
    object_key: objKey,
  }}
}

// ============================================================
// 获取材料下载预签名 URL（对象存储）
// ============================================================
export async function getMaterialDownloadUrl(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const tid = getParam(req, 'template_id')
  if (!rid || !tid) return { body: { error: '缺少必要字段' }, statusCode: 400 }
  const key = `${rid}_mat_${tid}`
  const ex = (await matItem.get(key)) as any
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  const objKey = ex.file_data || ''
  if (!objKey) return { body: { error: '该材料未上传文件' }, statusCode: 404 }
  const { object } = storage
  const result = await object.download(objKey) as any
  if (result?.code) {
    return { body: { error: `获取下载地址失败: ${result.message || result.code}` }, statusCode: 500 }
  }
  return { body: { url: result.getWebUrl(), file_name: ex.file_name || '' }}
}

// ============================================================
// 材料预览（后端代理获取文件内容，base64 返回，绕过 Content-Disposition: attachment）
// ============================================================
export async function getMaterialPreview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const tid = getParam(req, 'template_id')
  if (!rid || !tid) return { body: { error: '缺少必要字段' }, statusCode: 400 }
  const key = `${rid}_mat_${tid}`
  const ex = (await matItem.get(key)) as any
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  const objKey = ex.file_data || ''
  if (!objKey) return { body: { error: '该材料未上传文件' }, statusCode: 404 }
  const fileName = ex.file_name || 'unknown'
  const { object } = storage
  const result = await object.download(objKey) as any
  if (result?.code) {
    return { body: { error: `获取下载地址失败: ${result.message || result.code}` }, statusCode: 500 }
  }
  // 用 internal URL 后端请求文件内容
  const internalUrl = result.getUrl()
  try {
    const fetchRes = await OPFetch(internalUrl, { responseType: 'arraybuffer', timeout: 30000 } as any)
    const buf = Buffer.from(fetchRes.data as ArrayBuffer)
    const base64 = buf.toString('base64')
    // 根据文件扩展名推断 MIME
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
      txt: 'text/plain', csv: 'text/csv',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', rar: 'application/x-rar-compressed',
      '7z': 'application/x-7z-compressed',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    return { body: { content: base64, mime, file_name: fileName } }
  } catch (e: any) {
    return { body: { error: `预览获取失败: ${e.message || e}` }, statusCode: 500 }
  }
}

// ============================================================
// 历史附件下载/预览（按对象存储 key 直接获取，用于整改追加的旧版本文件）
// ============================================================
async function findAuthorizedAttachment(reviewUuid: string, objectKey: string): Promise<any | null> {
  const materials = await qAll(matItem, (v: any) => v.review_uuid === reviewUuid)
  for (const material of materials) {
    if (material.file_data === objectKey) {
      return {
        object_key: objectKey,
        file_name: material.file_name || 'unknown',
        material_template_id: material.template_id || '',
        current: true,
      }
    }
    const attachments = jsonArr(material.attachments_json || '[]')
    for (const attachment of attachments) {
      const key = attachment.object_key || attachment.key || attachment.file_data || ''
      if (key === objectKey) {
        return {
          object_key: objectKey,
          file_name: attachment.file_name || attachment.name || 'unknown',
          material_template_id: material.template_id || '',
          current: false,
        }
      }
    }
  }
  return null
}

export async function getAttachmentDownloadUrl(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const objKey = (getParam(req, 'object_key') || (req.query as any)?.object_key || '') as string
  if (!rid || !objKey) return { body: { error: '缺少 object_key' }, statusCode: 400 }
  const attachment = await findAuthorizedAttachment(rid, objKey)
  if (!attachment) return { body: { code: 'ATTACHMENT_NOT_FOUND', error: '附件不存在或不属于当前评审' }, statusCode: 404 }
  const { object } = storage
  const result = await object.download(objKey) as any
  if (result?.code) {
    return { body: { error: `获取下载地址失败: ${result.message || result.code}` }, statusCode: 500 }
  }
  return { body: { url: result.getWebUrl(), file_name: attachment.file_name, material_template_id: attachment.material_template_id }}
}

export async function getAttachmentPreview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const objKey = (getParam(req, 'object_key') || (req.query as any)?.object_key || '') as string
  if (!rid || !objKey) return { body: { error: '缺少 object_key' }, statusCode: 400 }
  const attachment = await findAuthorizedAttachment(rid, objKey)
  if (!attachment) return { body: { code: 'ATTACHMENT_NOT_FOUND', error: '附件不存在或不属于当前评审' }, statusCode: 404 }
  const fileName = attachment.file_name || 'unknown'
  const { object } = storage
  const result = await object.download(objKey) as any
  if (result?.code) {
    return { body: { error: `获取下载地址失败: ${result.message || result.code}` }, statusCode: 500 }
  }
  const internalUrl = result.getUrl()
  try {
    const fetchRes = await OPFetch(internalUrl, { responseType: 'arraybuffer', timeout: 30000 } as any)
    const buf = Buffer.from(fetchRes.data as ArrayBuffer)
    const base64 = buf.toString('base64')
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
      txt: 'text/plain', csv: 'text/csv',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip', rar: 'application/x-rar-compressed',
      '7z': 'application/x-7z-compressed',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    return { body: { content: base64, mime, file_name: fileName } }
  } catch (e: any) {
    return { body: { error: `预览获取失败: ${e.message || e}` }, statusCode: 500 }
  }
}

// ============================================================
// 材料状态
// ============================================================
export async function updateMaterialStatus(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const _matOp = getOperator(req)
  const { template_id, submit_status, notes } = b
  if (!rid || !template_id || !submit_status) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const evidenceContext = getEvidenceEditContext(rv)
  const denied = evidenceEditDenied(evidenceContext)
  if (denied) return denied
  const key = `${rid}_mat_${template_id}`
  const ex = await matItem.get(key)
  if (!ex) return { body: { error: '材料项不存在' }, statusCode: 404 }
  await matItem.set(key, {
    review_uuid: rid, template_id, submit_status,
    notes: notes ?? (ex as any).notes ?? '',
    updated_by: _matOp || b.updated_by || '', updated_at: Date.now(),
    file_name: (ex as any).file_name ?? '',
    file_data: (ex as any).file_data ?? '',
    file_size: (ex as any).file_size ?? 0, uploaded_at: (ex as any).uploaded_at ?? 0,
    round_no: evidenceContext.targetRound,
    // 保留固化字段
    material_name: (ex as any).material_name || '', required: (ex as any).required ?? 0,
    responsible_role: (ex as any).responsible_role || '', sort_order: (ex as any).sort_order ?? 0,
    attachments_json: (ex as any).attachments_json || '[]',
  })
  return { body: { ok: true } }
}

// ============================================================
// 指标
// ============================================================
export async function updateIndicators(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const operator_uuid = getOperator(req)
  const { indicators } = b
  if (!rid || !Array.isArray(indicators)) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const evidenceContext = getEvidenceEditContext(rv)
  const denied = evidenceEditDenied(evidenceContext)
  if (denied) return denied
  const now = Date.now()
  for (const ind of indicators) {
    const key = `${rid}_ind_${ind.template_id}`
    const ex = await indData.get(key)
    if (!ex) continue
    const v = Number(ind.current_value ?? 0)
    // 优先用实体固化的阈值计算颜色，旧数据回退实时模板
    const color = await calcRiskColor(ex, v)
    await indData.set(key, {
      review_uuid: rid, template_id: ind.template_id, current_value: v,
      notes: ind.notes ?? (ex as any).notes ?? '', risk_color: color,
      updated_by: operator_uuid || '', updated_at: now,
      round_no: evidenceContext.targetRound,
      // 保留固化字段（不覆盖）
      indicator_name: (ex as any).indicator_name || '', threshold_type: (ex as any).threshold_type || '',
      yellow_threshold: (ex as any).yellow_threshold ?? 0, red_threshold: (ex as any).red_threshold ?? 0,
      sort_order: (ex as any).sort_order ?? 0,
    })
  }
  return { body: { ok: true } }
}

// ============================================================
// 评审人维护
// ============================================================
export async function updateReviewers(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A+B：用真实身份，仅创建者可修改评审人
  const _rvOp = getOperator(req)
  const reviewers = Array.isArray(b.reviewers) ? b.reviewers : null
  if (!rid || !reviewers) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  if (_rvOp && (rv as any).creator_uuid && _rvOp !== (rv as any).creator_uuid) {
    return { body: { error: '仅创建者可修改评审人' }, statusCode: 403 }
  }
  if (rv.status !== 'draft') {
    return { body: { error: '评审已发起，不可修改评审人' }, statusCode: 403 }
  }

  const _rvType = (rv as any).review_type || 'dcp'
  const roleTemplates = await getRoleTemplatesForReview(rv)
  const roleNames = new Set(roleTemplates.map((r: any) => r.role_name))
  const normalized = reviewers
    .filter((r: any) => r && r.role_name && r.reviewer_uuid)
    .map((r: any) => ({
      role_name: String(r.role_name),
      reviewer_uuid: String(r.reviewer_uuid),
    }))

  for (const r of normalized) {
    if (!roleNames.has(r.role_name)) {
      return { body: { error: `未知评审角色：${r.role_name}` }, statusCode: 400 }
    }
  }

  // 校验：必投或否决权角色必须指定评审人
  const requiredRoles = roleTemplates.filter((rt: any) => rt.must_vote || rt.has_veto)
  const submittedRoleNames = new Set(normalized.map((r: any) => r.role_name))
  const missingRequired = requiredRoles.filter((rt: any) => !submittedRoleNames.has(rt.role_name)).map((rt: any) => rt.role_name)
  if (missingRequired.length > 0) {
    return { body: { error: `以下角色为必选，请先指定评审人：${missingRequired.join('、')}` }, statusCode: 400 }
  }

  // 校验：同一用户不允许担任多个角色
  const uuidToRoles: Record<string, string[]> = {}
  for (const r of normalized) {
    if (!uuidToRoles[r.reviewer_uuid]) uuidToRoles[r.reviewer_uuid] = []
    uuidToRoles[r.reviewer_uuid].push(r.role_name)
  }
  const multiRoleUsers = Object.entries(uuidToRoles).filter(([, roles]) => roles.length > 1)
  if (multiRoleUsers.length > 0) {
    const desc = multiRoleUsers.map(([uuid, roles]) => `${uuid}(${roles.join('/')})`).join('、')
    return { body: { error: `同一评审单中，一个用户不能同时担任多个评审角色：${desc}` }, statusCode: 400 }
  }

  const profileSnapshotRaw = (rv as any).reviewer_role_assignments_snapshot_json || ''
  const profileSnapshot = normalizeRoleAssignments(jsonArr(profileSnapshotRaw || '[]'))
  if (profileSnapshot.length > 0) {
    const snapshotErr = validateReviewersAgainstProfileSnapshot(normalized, profileSnapshot, roleTemplates)
    if (snapshotErr) {
      return { body: { error: snapshotErr }, statusCode: 400 }
    }
  }

  // 校验：决议角色必须指定且唯一（使用固化规则）
  let _rule: any
  try {
    _rule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }
  const publisherRole = getPublisherRole(_rule)
  if (publisherRole) {
    const publisherEntries = normalized.filter((r: any) => r.role_name === publisherRole)
    if (publisherEntries.length === 0) {
      return { body: { error: `决议角色「${publisherRole}」必须指定 1 名评审人` }, statusCode: 400 }
    }
    if (publisherEntries.length > 1) {
      return { body: { error: `决议角色「${publisherRole}」只能指定 1 名评审人` }, statusCode: 400 }
    }
  }

  // 按 sort_order 排序，稳定 key
  const ordered = normalized.sort((a, b) => {
    const ai = roleTemplates.find((r: any) => r.role_name === a.role_name)?.sort_order ?? 9999
    const bi = roleTemplates.find((r: any) => r.role_name === b.role_name)?.sort_order ?? 9999
    return ai - bi
  })

  // 删除旧评审人
  const old = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  for (const o of old) await rvReviewer.delete(o._key)

  // 写入新评审人，收集 payload 直接返回（不同请求内 qAll 回读）
  const savedPayload: any[] = []
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]
    const key = `${rid}_rvr_${i}`
    const value = {
      review_uuid: rid,
      reviewer_uuid: r.reviewer_uuid,
      role_name: r.role_name,
      selection_mode: profileSnapshot.find((s: any) => s.role_name === r.role_name)?.mode || '',
      default_reviewer_uuid: profileSnapshot.find((s: any) => s.role_name === r.role_name)?.default_reviewer_uuid || '',
      candidate_uuids_json: JSON.stringify(profileSnapshot.find((s: any) => s.role_name === r.role_name)?.candidate_uuids || []),
      conclusion: '', risk_level: 'medium', opinion_summary: '',
      submitted_at: 0,
    }
    await rvReviewer.set(key, value)
    savedPayload.push({ _key: key, ...value })
  }

  // 写 reviewers_json 快照到 dcp_review（兜底读取）
  try {
    await review.set(rid, cleanForSet({ ...rv, reviewers_json: JSON.stringify(savedPayload), updated_at: Date.now() }))
  } catch {}

  await writeAudit(rid, _rvOp || (req.body || {} as any).operator_uuid || '', '更新评审人', rid,
    `评审人已更新，共 ${savedPayload.length} 人`)
  return { body: { ok: true, saved_count: savedPayload.length, reviewers: savedPayload } }
}

// ============================================================
// 提交评审意见
// ============================================================
export async function submitOpinion(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  const { reviewer_uuid, role_name, conclusion, risk_level, opinion_summary } = b
  // 方案A+B：用真实身份，reviewer_uuid 必须与当前登录用户一致
  const _submitOp = getOperator(req)
  if (_submitOp && reviewer_uuid && _submitOp !== reviewer_uuid) {
    return { body: { error: '只能提交本人的评审意见' }, statusCode: 403 }
  }
  if (!rid || !reviewer_uuid || !role_name || !conclusion) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  if (rv.status !== 'reviewing') {
    return { body: { error: '当前状态不可提交评审意见' }, statusCode: 400 }
  }
  // 精确状态校验：仅 reviewing / re_reviewing 可提交意见
  const _effState = getEffectiveState(rv)
  if (_effState !== 'reviewing' && _effState !== 're_reviewing') {
    return { body: { error: '当前状态不可提交评审意见' }, statusCode: 400 }
  }
  // 优先从实体查询评审人，兜底从 reviewers_json 快照读取
  const currentRoundNo = (rv as any).round_no || 1
  let all = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  if (all.length === 0) {
    const snap = jsonArr((rv as any).reviewers_json || '[]')
    all = snap.map((s: any) => s._key ? s : { ...s, _key: `${rid}_snap_${Math.random().toString(36).slice(2, 6)}` })
  }
  // 按 uuid+role 查找评审人（不限制 round_no，兼容实体未被更新的情况）
  const target = all.find((r: any) =>
    r.reviewer_uuid === reviewer_uuid && r.role_name === role_name)
  if (!target) return { body: { error: '未找到该评审人的记录' }, statusCode: 404 }
  // 检查是否已在当前轮次提交（round_no 不匹配视为未提交）
  if (target.submitted_at > 0 && (target.round_no || 1) === currentRoundNo) {
    return { body: { error: '该评审人在当前轮次已提交过意见' }, statusCode: 409 }
  }

  // 评审人选「有条件通过」时，必须已创建至少 1 个整改工作项
  if (conclusion === 'conditional_pass') {
    const remediationItems = await qAll(linkedIssue,
      (v: any) => v.review_uuid === rid && v.link_type === 'remediation' && v.linked_by === reviewer_uuid)
    if (remediationItems.length === 0) {
      return { body: { error: '选择「有条件通过」时，必须先创建至少 1 个整改工作项' }, statusCode: 400 }
    }
  }

  // Checklist 全部完成校验：当前用户角色的所有检查项必须已勾选（pass/fail），不能有 unchecked
  {
    const cl = jsonArr((rv as any).checklist_json || '[]')
    const myChecklistItems = cl.filter((c: any) => c.role_name === role_name)
    if (myChecklistItems.length > 0) {
      const uncheckedItems = myChecklistItems.filter((c: any) => !c.status || c.status === 'unchecked')
      if (uncheckedItems.length > 0) {
        const names = uncheckedItems.map((c: any) => c.item_text || c.template_id).join('、')
        return { body: { error: `请先完成所有 Checklist 勾选后再提交评审意见，未勾选项：${names}` }, statusCode: 400 }
      }
    }
  }

  const ts = Date.now()
  const newData = {
    review_uuid: rid, reviewer_uuid, role_name,
    conclusion, risk_level: risk_level || 'medium',
    opinion_summary: opinion_summary || '',
    submitted_at: ts,
    round_no: currentRoundNo,
  }
  await rvReviewer.set(target._key, newData)
  // 同步更新 reviewers_json 快照，确保 qAll 回退路径读到最新数据
  // 同时检查是否满足决议前置条件 → 合并状态流转到同一次 set
  const curSnap = jsonArr((rv as any).reviewers_json || '[]')
  const updatedSnap = curSnap.map((s: any) =>
    (s.reviewer_uuid === reviewer_uuid && s.role_name === role_name)
      ? { ...s, ...newData, _key: s._key || target._key }
      : s
  )
  // 检查决议前置条件（使用固化规则）
  const _rvType = (rv as any).review_type || 'dcp'
  let _rule: any
  try {
    _rule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    // 旧数据无固化规则，不阻塞提交但跳过自动流转
    _rule = null
  }
  const _pubRole = _rule ? getPublisherRole(_rule) : ''
  let _ready = false
  if (_pubRole && updatedSnap.length > 0) {
    const _allRoleTpls = await getRoleTemplatesForReview(rv)
    _ready = isResolutionReady(_rule, updatedSnap, _allRoleTpls)
  }
  // 合并 review.set：快照更新 + 可能的状态流转
  let reviewUpdate: any = { ...rv, reviewers_json: JSON.stringify(updatedSnap), updated_at: ts }
  let transitioned = false
  if (_ready) {
    const currentState = getEffectiveState(rv)
    if (currentState === 'reviewing' || currentState === 're_reviewing') {
      const stateFields = buildStateTransition(rv, 'awaiting_resolution', reviewer_uuid, '前置评审完成，进入待决议')
      reviewUpdate = { ...reviewUpdate, ...stateFields }
      transitioned = true
    }
  }
  try {
    await review.set(rid, cleanForSet(reviewUpdate))
  } catch (e: any) {
    Logger.info(`[DCP] submitOpinion review.set failed (snapshot may be stale): ${e?.message || e}`)
  }
  await writeAudit(rid, reviewer_uuid, '提交评审意见', role_name,
    `评审意见: ${conclusion} | 风险: ${risk_level || 'medium'}`)

  // 满足决议前置条件 → 通知唯一决议人
  const notCfg2 = await getNotifyConfig()
  if (_ready && notCfg2.enabled && notCfg2.on_all_submitted) {
    const publisher = updatedSnap.find((r: any) => r.role_name === _pubRole)
    if (publisher && publisher.reviewer_uuid) {
      const phaseName = (rv as any).phase_code || ''
      const sendResult = await sendNotification(
        `${_rvType.toUpperCase()}决议通知 — ${phaseName}`,
        `「${phaseName}」评审已满足决议条件，请前往发布决议。`,
        `${(rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : ''}`,
        [publisher.reviewer_uuid],
      )
      Logger.info(`[DCP] submitOpinion notify publisher: publisher=${publisher.reviewer_uuid}, attempted=${sendResult.attempted.length}, succeeded=${sendResult.succeeded.length}, failed=${sendResult.failed.length}`)
      if (sendResult.failed.length > 0) {
        Logger.error(`[DCP] submitOpinion notify failed: ${JSON.stringify(sendResult.failed)}`)
      }
    } else {
      Logger.info(`[DCP] submitOpinion: ready but no publisher found, _pubRole=${_pubRole}`)
    }
  } else {
    Logger.info(`[DCP] submitOpinion: _ready=${_ready}, notify_enabled=${notCfg2.enabled}, on_all_submitted=${notCfg2.on_all_submitted}`)
  }

  return { body: { ok: true } }
}

// ============================================================
// 关联工作项
// ============================================================
type ProjectIssueTypeInfo = {
  scope_uuid: string
  issue_type_uuid: string
  name: string
}

type ProjectIssueTypesLookup = {
  project_uuid: string
  types: ProjectIssueTypeInfo[]
  verified: boolean
}

function normalizeProjectIssueTypes(raw: any[]): ProjectIssueTypeInfo[] {
  return raw.map((item: any) => ({
    scope_uuid: item.uuid || item.scope_uuid || '',
    issue_type_uuid: item.issue_type_uuid || item.uuid || '',
    name: item.name || item.issue_type_name || item.type_name || item.display_name || '',
  })).filter((item: ProjectIssueTypeInfo) => item.name)
}

async function getConfiguredRemediationIssueType(): Promise<{ name: string; uuid: string }> {
  const [nameRow, uuidRow] = await Promise.all([
    baseCfg.get('remediation_issue_type'),
    baseCfg.get('remediation_issue_type_uuid'),
  ])
  return {
    name: String((nameRow as any)?.value || ''),
    uuid: String((uuidRow as any)?.value || ''),
  }
}

function findConfiguredProjectIssueType(
  types: ProjectIssueTypeInfo[],
  configured: { name: string; uuid: string },
): ProjectIssueTypeInfo | undefined {
  if (configured.uuid) {
    const byUuid = types.find(item =>
      item.issue_type_uuid === configured.uuid || item.scope_uuid === configured.uuid)
    if (byUuid) return byUuid
  }
  return configured.name ? types.find(item => item.name === configured.name) : undefined
}

async function getProjectIssueTypes(teamUuid: string, projectRef: string): Promise<ProjectIssueTypesLookup> {
  let projectUuid = projectRef
  try {
    const exchangeRes = await OPFetch(
      `/project/api/ones-project/team/${teamUuid}/projects/exchange/${projectRef}`,
      { teamUUID: teamUuid },
    ) as any
    projectUuid = exchangeRes?.data?.project_uuid || exchangeRes?.project_uuid || projectRef
  } catch {}

  try {
    const stampRes = await OPFetch(
      `/project/api/project/team/${teamUuid}/project/${projectUuid}/stamps/data?t=issue_type_config`,
      {
        method: 'POST',
        teamUUID: teamUuid,
        headers: { 'Content-Type': 'application/json' },
        data: { issue_type_config: Date.now() },
      },
    ) as any
    const root = stampRes?.data || stampRes || {}
    const config = root.issue_type_config
    let raw: any[] | null = null
    if (Array.isArray(config)) raw = config
    else if (config && Array.isArray(config.issue_type_configs)) raw = config.issue_type_configs
    else if (config && Array.isArray(config.issue_types)) raw = config.issue_types
    if (raw) return { project_uuid: projectUuid, types: normalizeProjectIssueTypes(raw), verified: true }
  } catch {}

  try {
    const gqlRes = await OPFetch(`/project/api/project/team/${teamUuid}/items/graphql?t=projectIssueTypes`, {
      method: 'POST',
      teamUUID: teamUuid,
      headers: { 'Content-Type': 'application/json' },
      data: {
        query: `{ project(key: "project-${projectUuid}") { issueTypes { uuid name } } }`,
        variables: {},
      },
    }) as any
    const raw = gqlRes?.data?.project?.issueTypes
    if (Array.isArray(raw)) {
      return { project_uuid: projectUuid, types: normalizeProjectIssueTypes(raw), verified: true }
    }
  } catch {}

  return { project_uuid: projectUuid, types: [], verified: false }
}

export async function linkIssue(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const _linkOp = getOperator(req)
  const { issue_uuid, issue_number, issue_title, issue_type, issue_status } = b
  const linked_by = _linkOp || b.linked_by || ''
  const linkType = b.link_type || 'general'
  if (!rid || !issue_uuid) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  // 检查是否已关联
  const existing = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.issue_uuid === issue_uuid)
  if (existing.length > 0) {
    return { body: { error: '该工作项已关联' }, statusCode: 409 }
  }
  const rv = await review.get(rid)
  const currentRoundNo = rv ? ((rv as any).round_no || 1) : 1
  // 整改项：已提交评审意见的非决议人不可再关联整改工作项
  if (linkType === 'remediation' && rv && linked_by) {
    const isPublisher = await isPublisherRole(rv, linked_by)
    if (!isPublisher) {
      let allRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
      if (allRvrs.length === 0) allRvrs = jsonArr((rv as any).reviewers_json || '[]')
      const me = allRvrs.find((r: any) => r.reviewer_uuid === linked_by)
      if (me && me.submitted_at > 0 && (me.round_no || 1) === currentRoundNo) {
        return { body: { error: '已提交评审意见，不可再关联整改工作项' }, statusCode: 400 }
      }
    }
  }
  const key = `${rid}_li_${issue_uuid}`
  await linkedIssue.set(key, {
    review_uuid: rid, issue_uuid,
    issue_number: issue_number || '', issue_title: issue_title || '',
    issue_type: issue_type || '', issue_status: issue_status || '',
    linked_by: linked_by || '', linked_by_name: (b as any).linked_by_name || '', linked_at: Date.now(),
    link_type: linkType, round_no: currentRoundNo,
  })
  await writeAudit(rid, linked_by || '', linkType === 'remediation' ? '关联整改工作项' : '关联工作项', issue_uuid,
    `${linkType === 'remediation' ? '关联整改工作项' : '关联工作项'}: ${issue_number || issue_uuid}`)
  return { body: { ok: true } }
}

export async function getLinkedIssues(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const issues = await qAll(linkedIssue, (v: any) => v.review_uuid === rid)
  issues.sort((a: any, b: any) => (b.linked_at || 0) - (a.linked_at || 0))
  const issuesNormalized = issues.map((v: any) => ({ ...v, issue_status: normalizeIssueStatus(v.issue_status) }))
  return { body: { issues: issuesNormalized } }
}

// ============================================================
// 创建工作项并自动关联评审单
// ============================================================
export async function createIssue(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const tuid = getParam(req, 'team_uuid')
  if (!tuid) return { body: { error: '无法获取 team_uuid' }, statusCode: 400 }

  // 获取评审单信息
  const rvs = await qAll(review, (v: any) => v.review_uuid === rid)
  if (rvs.length === 0) return { body: { error: '评审单不存在' }, statusCode: 404 }
  const rv = rvs[0]

  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const _createIssueOp = getOperator(req)
  const {
    title,
    issue_type_scope_uuid,  // 项目内 IssueTypeScope.uuid
    issue_type_uuid,        // 全局工作项类型 UUID
    assignee_uuid,
    project_uuid,
  } = b
  if (!title) {
    return { body: { error: '缺少 title' }, statusCode: 400 }
  }

  // 已提交评审意见的非决议人不可再创建整改工作项
  {
    const linkedBy = _createIssueOp || (b as any).linked_by || assignee_uuid || rv.creator_uuid || ''
    if (linkedBy) {
      const isPublisher = await isPublisherRole(rv, linkedBy)
      if (!isPublisher) {
        const _ciRoundNo = (rv as any).round_no || 1
        let allRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
        if (allRvrs.length === 0) allRvrs = jsonArr((rv as any).reviewers_json || '[]')
        const me = allRvrs.find((r: any) => r.reviewer_uuid === linkedBy)
        if (me && me.submitted_at > 0 && (me.round_no || 1) === _ciRoundNo) {
          return { body: { error: '已提交评审意见，不可再创建整改工作项' }, statusCode: 400 }
        }
      }
    }
  }

  // 解析项目真实 UUID
  let projectID = project_uuid || rv.project_uuid || ''
  try {
    const exchRes = await OPFetch(
      `/project/api/ones-project/team/${tuid}/projects/exchange/${projectID}`,
      { teamUUID: tuid }
    ) as any
    if (exchRes?.data?.project_uuid || exchRes?.project_uuid) projectID = exchRes?.data?.project_uuid || exchRes?.project_uuid
  } catch {}

  // 配置了整改默认类型时，只允许使用当前项目已启用的对应类型。
  const configuredType = await getConfiguredRemediationIssueType()
  let selectedProjectType: ProjectIssueTypeInfo | undefined
  if (configuredType.name || configuredType.uuid) {
    const lookup = await getProjectIssueTypes(tuid, projectID)
    projectID = lookup.project_uuid
    if (!lookup.verified) {
      return { body: {
        code: 'REMEDIATION_ISSUE_TYPE_UNVERIFIED',
        error: '无法确认当前项目的工作项类型，不允许新建整改项。请刷新后重试。',
      }, statusCode: 409 }
    }
    selectedProjectType = findConfiguredProjectIssueType(lookup.types, configuredType)
    if (!selectedProjectType) {
      return { body: {
        code: 'REMEDIATION_ISSUE_TYPE_NOT_AVAILABLE',
        error: `当前项目未添加 DCP 评审中心配置的整改工作项类型「${configuredType.name || configuredType.uuid}」，不允许新建。请先在项目设置中添加该类型，或调整 DCP 评审中心的整改设置。`,
      }, statusCode: 409 }
    }
  }

  // tasks/add3 使用全局工作项类型 UUID；历史名称配置由项目类型匹配结果补齐 UUID。
  const typeUuid = selectedProjectType?.issue_type_uuid || issue_type_uuid || ''
  const typeScopeUuid = selectedProjectType?.scope_uuid || issue_type_scope_uuid || ''

  try {
    let res: any = null
    const errors: any[] = []

    // 内部 API 多路径级联尝试
    const internalPaths = [
      `/project/api/project/team/${tuid}/tasks/add3`,
      `/project/api/project/team/${tuid}/tasks`,
      `/project/api/project/team/${tuid}/items`,
      `/project/api/project/team/${tuid}/task`,
      `/project/api/ones-project/team/${tuid}/tasks`,
    ]
    for (const path of internalPaths) {
      if (res?.data?.uuid || res?.data?.tasks?.[0]?.uuid) break
      try {
        const isAdd3 = path.endsWith('/add3')
        const add3Body = isAdd3 ? {
          tasks: [{
            uuid: Array.from({length: 16}, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join(''),
            project_uuid: projectID,
            issue_type_uuid: typeUuid || undefined,
            field_values: [
              { field_uuid: 'field001', value: title },
              { field_uuid: 'field006', value: projectID },
              { field_uuid: 'field007', value: typeUuid },
              { field_uuid: 'field004', value: assignee_uuid || rv.creator_uuid || '' },
            ],
          }],
        } : {
          assignee: assignee_uuid || rv.creator_uuid || '',
          title,
          project_uuid: projectID,
          issue_type_uuid: typeUuid || undefined,
        }
        res = await OPFetch(path, {
          method: 'POST',
          teamUUID: tuid,
          headers: { 'Content-Type': 'application/json' },
          data: add3Body,
        }) as any
        if (isAdd3 && res?.data?.tasks?.[0]?.uuid) {
          const t = res.data.tasks[0]
          res.data = { uuid: t.uuid, display_id: t.display_id, issue_number: t.display_id }
        }
        if (res?.data?.uuid || res?.data?.issue_uuid) break
      } catch (innerErr: any) {
        errors.push({
          path,
          message: innerErr?.message || '',
          status: innerErr?.response?.status || innerErr?.status,
          data: innerErr?.response?.data || innerErr?.data,
          errcode: innerErr?.response?.data?.errcode || innerErr?.data?.errcode,
        })
        Logger.error('[DCP] create issue internal API failed:', JSON.stringify(errors[errors.length - 1]))
      }
    }

    const issueData = res?.data || res || {}
    const issueUuid = issueData.uuid || issueData.issue_uuid || ''
    const issueNumber = issueData.display_id || issueData.issue_number || ''

    if (!issueUuid) {
      // 所有内部 API 路径都失败，返回 fallback URL
      const fallbackUrl = `#/team/${tuid}/project/${projectID}/task/create`
      const errDetail = errors[0]?.errcode || errors[0]?.message || '未知错误'
      return { body: {
        error: `创建工作项失败：${errDetail}`,
        detail: {
          project_uuid: projectID,
          issue_type_uuid: typeUuid,
          issue_type_scope_uuid: typeScopeUuid,
          errors,
        },
        fallback_url: fallbackUrl,
      }, statusCode: 500 }
    }

    // 自动关联到评审单
    const key = `${rid}_li_${issueUuid}`
    await linkedIssue.set(key, {
      review_uuid: rid,
      issue_uuid: issueUuid,
      issue_number: issueNumber,
      issue_title: title,
      issue_type: selectedProjectType?.name || issue_type_uuid || typeScopeUuid || '',
      issue_status: '',
      linked_by: _createIssueOp || b.linked_by || assignee_uuid || rv.creator_uuid || '',
      linked_by_name: b.linked_by_name || '',
      linked_at: Date.now(),
      link_type: 'remediation',
      round_no: (rv as any).round_no || 1,
    })

    await writeAudit(rid, _createIssueOp || assignee_uuid || rv.creator_uuid || '', '创建工作项', issueUuid,
      `创建工作项并关联: ${issueNumber || issueUuid} - ${title}`)

    return { body: { ok: true, issue_uuid: issueUuid, issue_number: issueNumber } }
  } catch (e: any) {
    const errMsg = e?.message || e?.errcode || '未知错误'
    Logger.error('[DCP] createIssue error:', errMsg, e)
    const fallbackUrl = `#/team/${tuid}/project/${projectID}/task/create`
    return { body: { error: `创建工作项失败: ${errMsg}`, fallback_url: fallbackUrl }, statusCode: 500 }
  }
}

// ============================================================
// 发布决议（按 review_type 规则配置，全部提交后，不可覆盖）
// ============================================================
export async function publishResolution(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A+B：用真实身份，publisher_uuid 必须与当前登录用户一致
  const _pubOp = getOperator(req)
  const {
    final_conclusion,    // pass | conditional_pass | reject | fail | rework
    condition_notes,
    publisher_name,
  } = b
  // 兼容旧字段
  const fc = final_conclusion || b.resolution_result
  const cn = condition_notes || b.resolution_body || ''
  const puuid = _pubOp || b.publisher_uuid || b.operator_uuid || ''

  // 校验：publisher_uuid 必须与真实身份一致（防止冒充）
  if (_pubOp && b.publisher_uuid && _pubOp !== b.publisher_uuid) {
    return { body: { error: '只能以本人身份发布决议' }, statusCode: 403 }
  }

  if (!rid || !fc) {
    return { body: { error: '缺少 final_conclusion' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  // 精确状态校验：reviewing / re_reviewing / awaiting_resolution 可发布决议（以 review_state 为准，不依赖旧 status 字段）
  const effState = getEffectiveState(rv)
  if (effState !== 'reviewing' && effState !== 'awaiting_resolution' && effState !== 're_reviewing') {
    return { body: { error: '当前状态不可发布决议' }, statusCode: 400 }
  }

  // 按 review_type 获取固化决议规则
  const reviewType = (rv as any).review_type || 'dcp'
  let rule: any
  try {
    rule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }

  // 兼容旧版中文结论
  let normalizedFc = fc
  const CN_MAP: any = { '通过': 'pass', '有条件通过': 'conditional_pass', '否决': 'reject', '不通过': 'fail', '返工': 'rework' }
  if (!rule.allowedConclusions.includes(fc)) {
    if (CN_MAP[fc]) {
      normalizedFc = CN_MAP[fc]
    } else {
      return { body: { error: `当前评审类型不支持该决议结果：${fc}` }, statusCode: 400 }
    }
  }
  if (!rule.allowedConclusions.includes(normalizedFc)) {
    return { body: { error: `当前评审类型（${reviewType.toUpperCase()}）不支持该决议结果：${normalizedFc}` }, statusCode: 400 }
  }

  // 读取评审人（优先实体查询，兜底快照）
  const snap = jsonArr((rv as any).reviewers_json || '[]')
  let allRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  if (allRvrs.length === 0) {
    allRvrs = snap
  }
  if (allRvrs.length === 0) {
    return { body: { error: '未找到评审人记录' }, statusCode: 400 }
  }
  // 投影到当前轮次：旧轮次的提交数据视为未提交
  const _pubRoundNo = (rv as any).round_no || 1
  allRvrs = allRvrs.map((r: any) => {
    if ((r.round_no || 1) !== _pubRoundNo) {
      return { ...r, submitted_at: 0, conclusion: '', risk_level: '', opinion_summary: '', round_no: _pubRoundNo }
    }
    return r
  })

  // 校验：操作人必须是评审人
  const publisherReviewer = allRvrs.find((r: any) => r.reviewer_uuid === puuid)
  if (!publisherReviewer) {
    return { body: { error: '当前用户不是该评审单的评审人，不能发布决议' }, statusCode: 403 }
  }

  // 校验：发布人角色必须是唯一决议角色
  const publisherRole = getPublisherRole(rule)
  if (!publisherRole) {
    return { body: { error: `${reviewType.toUpperCase()} 决议角色未配置，请先在插件配置中设置允许发布 ${reviewType.toUpperCase()} 决议的角色。` }, statusCode: 400 }
  }
  const publisherReviewers = allRvrs.filter((r: any) => r.role_name === publisherRole)
  if (publisherReviewers.length !== 1) {
    return { body: { error: `决议角色「${publisherRole}」必须且只能指定 1 名评审人` }, statusCode: 400 }
  }
  if (publisherReviewers[0].reviewer_uuid !== puuid) {
    return { body: { error: `当前用户不是该评审单的决议人（决议角色：${publisherRole}），不能发布决议` }, statusCode: 403 }
  }

  // 按评审单固化的角色模板
  const roleTemplates = await getRoleTemplatesForReview(rv)
  const submitMode = rule.submitRequirement.mode || 'must_vote_roles'
  if (submitMode === 'must_vote_roles') {
    const mustVoteRoleNames = (rule._frozen?.mustVoteRoleNames) || roleTemplates.filter((rt: any) => rt.must_vote).map((rt: any) => rt.role_name)
    const unsubmitted = allRvrs.filter((r: any) => {
      if (!mustVoteRoleNames.includes(r.role_name)) return false
      return r.submitted_at === 0 || !r.submitted_at
    })
    if (unsubmitted.length > 0) {
      return { body: {
        error: `仍有 ${unsubmitted.length} 名评审人未提交意见`,
        unsubmitted: unsubmitted.map((r: any) => `${r.role_name}`),
      }, statusCode: 400 }
    }
  } else if (submitMode === 'all_reviewers') {
    const unsubmitted = allRvrs.filter((r: any) => r.submitted_at === 0 || !r.submitted_at)
    if (unsubmitted.length > 0) {
      return { body: {
        error: `仍有 ${unsubmitted.length} 名评审人未提交意见`,
        unsubmitted: unsubmitted.map((r: any) => `${r.role_name}`),
      }, statusCode: 400 }
    }
  } else if (submitMode === 'vote_scope_roles') {
    // 计票范围内角色全部提交（优先使用冻结角色范围）
    const scopeNames = (rule._frozen?.voteScopeRoleNames) || resolveVoteScopeRoleNames(rule, roleTemplates)
    const unsubmitted = allRvrs.filter((r: any) => {
      if (!scopeNames.includes(r.role_name)) return false
      return r.submitted_at === 0 || !r.submitted_at
    })
    if (unsubmitted.length > 0) {
      return { body: {
        error: `仍有 ${unsubmitted.length} 名评审人未提交意见`,
        unsubmitted: unsubmitted.map((r: any) => `${r.role_name}`),
      }, statusCode: 400 }
    }
  }
  // publisher_only 模式：只要求发布人存在，不校验其他人

  // 校验：通过规则（传入冻结角色范围）
  const passResult = validatePassRule(rule.passRule, allRvrs, roleTemplates, normalizedFc, rule._frozen)
  if (!passResult.ok) {
    return { body: { error: passResult.error }, statusCode: 400 }
  }

  // 校验：决议门径硬约束（指标红线 / Checklist 完整 / 前置阶段有效）
  // 仅对 gatePolicy.enforceOn 中的结论生效（默认仅 pass）；warn 放行但记审计
  const _gateInds = await qAll(indData, (v: any) => v.review_uuid === rid)
  const _gateIndTpls = await qAll(indTpl)
  const _gateSnapshotIndicators = _gateInds.map((ind: any) => {
    const frozenName = ind.indicator_name || ''
    const tpl = !frozenName ? _gateIndTpls.find((t: any) => t._key === ind.template_id) as any : null
    return {
      indicator_name: frozenName || tpl?.indicator_name || '',
      current_value: ind.current_value || 0,
      risk_color: ind.risk_color || 'green',
      notes: ind.notes || '',
    }
  })
  const _gateChecklist = jsonArr((rv as any).checklist_json || '[]')
  const _gateProjectIds = new Set([String((rv as any).project_uuid || '')])
  const gateResult = await validateResolutionGate(rv, rule, normalizedFc, _gateSnapshotIndicators, _gateChecklist, _gateProjectIds)
  if (!gateResult.ok) {
    await writeAudit(rid, puuid, '门径校验拦截', rid,
      `pass 被门径拦截: ${gateResult.violations.map((v: any) => v.type).join(',')}`)
    return {
      body: {
        code: 'RESOLUTION_GATE_BLOCKED',
        error: '决议为「通过」但门径未达标，请降级为「有条件通过」并挂整改项，或调整指标/检查项后重试',
        gateViolations: gateResult.violations,
        suggestDowngrade: gateResult.suggestDowngrade,
      },
      statusCode: 422,
    }
  }
  if (gateResult.warnings.length > 0) {
    await writeAudit(rid, puuid, '门径校验警告', rid,
      `pass 放行但存在门径警告: ${gateResult.warnings.map((v: any) => v.type).join(',')}`)
  }

  // 按当前轮次判断是否已有决议（支持多轮决议）
  const currentRoundNo = (rv as any).round_no || 1
  const existing = await qAll(resolution,
    (v: any) => v.review_uuid === rid && (v.round_no || 1) === currentRoundNo)
  if (existing.length > 0) {
    return { body: { error: `第${currentRoundNo}轮决议已发布，不可覆盖` }, statusCode: 409 }
  }

  const now = Date.now()
  const snapshotNumber = `DCP-RES-R${currentRoundNo}-${now.toString(36).toUpperCase()}`

  // conditional_pass / rework 必须填写条件说明
  if ((normalizedFc === 'conditional_pass' || normalizedFc === 'rework') && !cn.trim()) {
    return { body: { error: '有条件通过/返工必须填写条件说明' }, statusCode: 400 }
  }
  // 整改项非必填：评审人已创建的整改项足够时，决议人无需重复创建

  // 决议实体 — 多轮使用轮次相关 key
  const resKey = currentRoundNo > 1 ? `${rid}_r${currentRoundNo}` : rid

  // 冻结快照：材料、指标、checklist、整改工作项（与评审人意见一起留存到 based_on_votes）
  const [snapMaterials, snapIndicators, snapChecklistRaw, snapIssues] = await Promise.all([
    qAll(matItem, (v: any) => v.review_uuid === rid),
    qAll(indData, (v: any) => v.review_uuid === rid),
    Promise.resolve((rv as any).checklist_json || '[]'),
    qAll(linkedIssue, (v: any) => v.review_uuid === rid),
  ])
  const snapshotMaterials = snapMaterials.map((m: any) => ({
    template_id: m.template_id || '',
    material_name: m.material_name || '',
    required: Number(m.required || 0),
    responsible_role: m.responsible_role || '',
    file_name: m.file_name || '',
    file_data: m.file_data || '',
    file_size: Number(m.file_size || 0),
    uploaded_at: Number(m.uploaded_at || 0),
    round_no: Number(m.round_no || currentRoundNo),
    attachment_count: jsonArr(m.attachments_json || '[]').length,
  }))
  const allIndTpls = await qAll(indTpl)
  const snapshotIndicators = snapIndicators.map((ind: any) => {
    // 优先读评审单指标实体的固化字段，旧数据无固化时回退实时模板
    const frozenName = ind.indicator_name || ''
    const tpl = !frozenName ? allIndTpls.find((t: any) => t._key === ind.template_id) as any : null
    return {
      indicator_name: frozenName || tpl?.indicator_name || '',
      current_value: ind.current_value || 0,
      risk_color: ind.risk_color || 'green',
      notes: ind.notes || '',
    }
  })
  const snapshotChecklist = jsonArr(snapChecklistRaw)
  const snapshotIssues = snapIssues.map((iss: any) => ({
    issue_number: iss.issue_number || '',
    issue_title: iss.issue_title || '',
    issue_status: normalizeIssueStatus(iss.issue_status),
    linked_by_name: iss.linked_by_name || '',
  }))

  await resolution.set(resKey, {
    review_uuid: rid,
    final_conclusion: normalizedFc,
    condition_notes: cn,
    based_on_votes: JSON.stringify({
      votes: allRvrs.map((r: any) => ({
        reviewer_uuid: r.reviewer_uuid,
        role_name: r.role_name,
        conclusion: r.conclusion || '',
        risk_level: r.risk_level || 'medium',
        opinion_summary: r.opinion_summary || '',
        submitted_at: r.submitted_at || 0,
      })),
      indicators: snapshotIndicators,
      checklist: snapshotChecklist,
      issues: snapshotIssues,
      materials: snapshotMaterials,
    }),
    snapshot_number: snapshotNumber,
    published_by: puuid,
    published_by_name: publisher_name || '',
    published_at: now,
    round_no: currentRoundNo,
  })
  // 根据决议结论确定目标状态
  let targetState: string
  let newStatus: string
  if (normalizedFc === 'pass') {
    targetState = 'completed'; newStatus = 'completed'
  } else if (normalizedFc === 'conditional_pass') {
    // 有条件通过 → 先进入 resolution_published，再进入 remediation_pending
    targetState = 'remediation_pending'; newStatus = 'reviewing'
  } else if (normalizedFc === 'rework') {
    targetState = 'remediation_pending'; newStatus = 'reviewing'
  } else {
    // reject / fail
    targetState = 'rejected'; newStatus = 'rejected'
  }
  const fcLabel = normalizedFc === 'pass' ? '通过' : normalizedFc === 'conditional_pass' ? '有条件通过' : normalizedFc === 'fail' ? '不通过' : normalizedFc === 'rework' ? '返工' : '驳回'
  const stateFields = buildStateTransition(rv, targetState, puuid, `决议：${fcLabel}`)
  await review.set(rid, cleanForSet({ ...rv, ...stateFields }))
  if (targetState === 'rejected') await releasePhaseGuard({ ...rv, review_uuid: rid })
  await writeAudit(rid, puuid, '发布决议', rid,
    `决议已发布: ${normalizedFc} [${snapshotNumber}]`)

  // 通知创建者 + 所有评审人（决议发布后）
  const notCfg3 = await getNotifyConfig()
  if (notCfg3.enabled && notCfg3.on_resolution) {
    const notUsers: string[] = []
    // 创建者
    const cid = (rv as any).creator_uuid
    if (cid && cid !== puuid) notUsers.push(cid)
    // 所有评审人（排除发布人自己）
    for (const r of allRvrs) {
      if (r.reviewer_uuid && r.reviewer_uuid !== puuid && !notUsers.includes(r.reviewer_uuid)) {
        notUsers.push(r.reviewer_uuid)
      }
    }
    if (notUsers.length > 0) {
      const phaseName = (rv as any).phase_code || ''
      const fcLabel = normalizedFc === 'pass' ? '通过' : normalizedFc === 'conditional_pass' ? '有条件通过' : normalizedFc === 'fail' ? '不通过' : normalizedFc === 'rework' ? '返工' : '驳回'
      await sendNotification(
        `${reviewType.toUpperCase()}决议结果 — ${phaseName}`,
        `「${phaseName}」决议已发布：${fcLabel}。详情请查看评审单。`,
        `${(rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : ''}`,
        notUsers,
      )
    }
  }

  return { body: { ok: true, snapshot_number: snapshotNumber, status: newStatus, review_state: targetState, gateWarnings: gateResult.warnings || [] } }
}

// 兼容旧名
export async function generateResolution(req: any): Promise<PluginResponse> {
  return publishResolution(req)
}

// ============================================================
// 补充/纠偏说明
// ============================================================
export async function addSupplement(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const _suppOp = getOperator(req)
  const { note_type, note_title, note_content } = b
  const submitted_by = _suppOp || b.submitted_by || ''
  if (!rid || !note_type || !note_title || !note_content) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  if (!['supplement', 'rectification'].includes(note_type)) {
    return { body: { error: 'note_type 必须为 supplement 或 rectification' }, statusCode: 400 }
  }
  const key = `${rid}_supp_${Date.now()}`
  await supplement.set(key, {
    review_uuid: rid, note_type, note_title, note_content,
    submitted_by: submitted_by || '', submitted_at: Date.now(),
  })
  const label = note_type === 'supplement' ? '补充说明' : '纠偏说明'
  await writeAudit(rid, submitted_by || '', `添加${label}`, rid, `${label}: ${note_title}`)
  return { body: { ok: true } }
}

// ============================================================
// Checklist 勾选/取消
// ============================================================
export async function checkChecklist(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A+B：用真实身份，reviewer_uuid 必须与当前登录用户一致
  const _chkOp = getOperator(req)
  const { template_id, status, reviewer_uuid } = b
  if (_chkOp && reviewer_uuid && _chkOp !== reviewer_uuid) {
    return { body: { error: '只能操作本人的检查项' }, statusCode: 403 }
  }
  if (!rid || !template_id || !status) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  if (!['unchecked', 'pass', 'fail'].includes(status)) {
    return { body: { error: 'status 必须为 unchecked / pass / fail' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  // 使用 effective_state 精确判断（reviewing / re_reviewing 可操作）
  const _chkEffState = getEffectiveState(rv)
  if (_chkEffState !== 'reviewing' && _chkEffState !== 're_reviewing') {
    return { body: { error: '当前状态不可操作 checklist' }, statusCode: 400 }
  }
  const cl = jsonArr((rv as any).checklist_json || '[]')
  const idx = cl.findIndex((c: any) => c.template_id === template_id)
  if (idx === -1) return { body: { error: '检查项不存在' }, statusCode: 404 }

  // 权限：操作人必须是对应角色的评审人，且不是决议发布角色
  const item = cl[idx]
  // 优先从 rvReviewer 实体查询，兜底从 reviewers_json 快照读取
  let snapReviewers = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  if (snapReviewers.length === 0) {
    snapReviewers = jsonArr((rv as any).reviewers_json || '[]')
  }
  const myReviewer = snapReviewers.find((r: any) => r.reviewer_uuid === reviewer_uuid)
  if (!myReviewer) return { body: { error: '你不是本评审的评审人' }, statusCode: 403 }
  // 已提交评审意见的评审人不可再操作 checklist
  const _chkRoundNo = (rv as any).round_no || 1
  if (myReviewer.submitted_at > 0 && (myReviewer.round_no || 1) === _chkRoundNo) {
    return { body: { error: '已提交评审意见，不可再修改 Checklist' }, statusCode: 400 }
  }
  // 决议发布角色不可操作 checklist（使用固化规则）
  let _rule: any
  try {
    _rule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }
  const _pubRole = getPublisherRole(_rule)
  if (_pubRole && myReviewer.role_name === _pubRole) {
    return { body: { error: '决议发布角色不可操作 checklist' }, statusCode: 403 }
  }
  if (myReviewer.role_name !== item.role_name) {
    return { body: { error: '该检查项不属于你的角色' }, statusCode: 403 }
  }

  cl[idx] = { ...item, status, checked_by: reviewer_uuid, checked_at: Date.now() }
  await review.set(rid, cleanForSet({ ...rv, checklist_json: JSON.stringify(cl), updated_at: Date.now() }))
  return { body: { ok: true, item: cl[idx] } }
}

// ============================================================
// 审计日志
// ============================================================
export async function getAuditLog(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const logs = await qAll(auditLog, (v: any) => v.review_uuid === rid)
  logs.sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
  return { body: { logs } }
}

// ============================================================
// 手动催办（催办评审人 / 催办决议人）
// ============================================================
export async function remindReview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const operator_uuid = getOperator(req)
  const { target, operator_name } = b

  if (!rid || !target || !operator_uuid) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  if (target !== 'reviewers' && target !== 'resolution') {
    return { body: { error: 'target 必须为 reviewers 或 resolution' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  // 权限校验：仅评审发起人可催办
  if (rv.creator_uuid !== operator_uuid) {
    return { body: { error: '仅评审发起人可催办' }, statusCode: 403 }
  }

  // 状态校验：仅评审中可催办
  if (rv.status !== 'reviewing') {
    return { body: { error: '当前状态不可催办' }, statusCode: 400 }
  }
  const _remindEffState = getEffectiveState(rv)
  if (_remindEffState !== 'reviewing' && _remindEffState !== 'awaiting_resolution' && _remindEffState !== 're_reviewing') {
    return { body: { error: '当前状态不可催办' }, statusCode: 400 }
  }

  // 通知配置校验
  const notifyCfg = await getNotifyConfig()
  if (!notifyCfg.enabled) {
    return { body: { error: '通知功能未开启' }, statusCode: 400 }
  }
  // 兼容旧配置：如果没有 on_manual_remind 字段，视为开启
  if (notifyCfg.on_manual_remind === false) {
    return { body: { error: '手动催办功能未开启' }, statusCode: 400 }
  }

  // 冷却校验
  const cooldown = Number(notifyCfg.remind_cooldown_seconds || 60) * 1000
  const recent = await qAll(auditLog, (v: any) =>
    v.review_uuid === rid &&
    v.action === '手动催办' &&
    v.target === target &&
    Date.now() - Number(v.timestamp || 0) < cooldown
  )
  if (recent.length > 0) {
    return { body: { error: '催办过于频繁，请稍后再试' }, statusCode: 429 }
  }

  // 读取评审人（优先实体查询，兜底快照）
  const snapReviewers = jsonArr((rv as any).reviewers_json || '[]')
  const entityReviewers = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
  const reviewers = entityReviewers.length > 0 ? entityReviewers : snapReviewers
  if (reviewers.length === 0) {
    return { body: { error: '暂无需要催办的评审人' }, statusCode: 400 }
  }

  const reviewType = (rv as any).review_type || 'dcp'
  let rule: any
  try {
    rule = await getResolutionRuleForReview(rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }
  const publisherRole = getPublisherRole(rule)
  const phaseName = (rv as any).phase_code || ''
  const reviewTitle = (rv as any).review_title || 'DCP评审'
  const rtLabel = reviewType.toUpperCase()
  const url = (rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : ''

  if (target === 'reviewers') {
    // 催办评审人：排除决议角色，仅催办未提交的前置评审人
    const pendingReviewers = reviewers.filter((r: any) => {
      if (!r.reviewer_uuid) return false
      if (publisherRole && r.role_name === publisherRole) return false
      return Number(r.submitted_at || 0) <= 0
    })
    if (pendingReviewers.length === 0) {
      return { body: { error: '暂无需要催办的评审人' }, statusCode: 400 }
    }

    const toUsers = pendingReviewers.map((r: any) => r.reviewer_uuid)
    const sendResult = await sendNotification(
      `${rtLabel}评审催办 — ${phaseName}`,
      `您有待处理的「${phaseName} ${reviewTitle}」评审意见，请尽快前往评审工作台提交。`,
      url,
      toUsers,
    )

    // 审计日志（detail 上限 2048，截断接收人列表）
    const recipientSummary = pendingReviewers.slice(0, 20).map((r: any) => ({ uuid: r.reviewer_uuid, role_name: r.role_name }))
    const detail = JSON.stringify({
      target, recipient_count: pendingReviewers.length,
      recipients: recipientSummary, channels: sendResult.attempted,
    }).slice(0, 2048)
    await writeAudit(rid, operator_uuid, '手动催办', target, detail)

    return { body: {
      ok: true, target: 'reviewers',
      recipient_count: pendingReviewers.length,
      recipients: pendingReviewers.map((r: any) => ({ uuid: r.reviewer_uuid, role_name: r.role_name })),
      channels: sendResult.attempted,
    }}
  }

  // target === 'resolution'：催办决议人
  const roleTemplates = await getRoleTemplatesForReview(rv)
  const ready = isResolutionReady(rule, reviewers, roleTemplates)
  if (!ready) {
    return { body: { error: '当前评审单尚未进入待决议状态' }, statusCode: 400 }
  }

  // 确认尚未发布决议
  const existingRes = await qAll(resolution, (v: any) => v.review_uuid === rid)
  const hasPublished = existingRes.some((r: any) => Number(r.published_at || 0) > 0)
  if (hasPublished) {
    return { body: { error: '当前评审单尚未进入待决议状态' }, statusCode: 400 }
  }

  // 找到唯一决议人
  const publisher = reviewers.find((r: any) => r.role_name === publisherRole && r.reviewer_uuid)
  if (!publisher) {
    return { body: { error: '未找到决议人' }, statusCode: 400 }
  }

  const sendResult = await sendNotification(
    `${rtLabel}决议催办 — ${phaseName}`,
    `「${phaseName} ${reviewTitle}」已满足决议条件，请尽快前往评审单发布决议。`,
    url,
    [publisher.reviewer_uuid],
  )

  const detail = JSON.stringify({
    target, recipient_count: 1,
    recipients: [{ uuid: publisher.reviewer_uuid, role_name: publisher.role_name }],
    channels: sendResult.attempted,
  }).slice(0, 2048)
  await writeAudit(rid, operator_uuid, '手动催办', target, detail)

  return { body: {
    ok: true, target: 'resolution',
    recipient_count: 1,
    recipients: [{ uuid: publisher.reviewer_uuid, role_name: publisher.role_name }],
    channels: sendResult.attempted,
  }}
}

// ============================================================
// 别名：ONES 平台可能自动生成的函数名
// ============================================================
export async function getDcpConfig(req: any): Promise<PluginResponse> {
  return getPluginConfig(req)
}

export async function getDcpReviews(req: any): Promise<PluginResponse> {
  const puid = getParam(req, 'project_uuid')
  if (puid) return listReviewsByProject(req)
  return listTeamReviews(req)
}

// ============================================================
// 获取项目工作项类型列表（调用 ONES Open API）
// ============================================================
export async function listIssueTypes(req: any): Promise<PluginResponse> {
  const tuid = getParam(req, 'team_uuid')
  const puid = getParam(req, 'project_uuid')
  if (!tuid || !puid) return { body: { error: '缺少 team_uuid 或 project_uuid' }, statusCode: 400 }

  const lookup = await getProjectIssueTypes(tuid, puid)
  const issueTypes = lookup.types.map(item => ({
    uuid: item.issue_type_uuid,
    scope_uuid: item.scope_uuid,
    issue_type_uuid: item.issue_type_uuid,
    name: item.name,
  }))
  return { body: {
    issue_types: issueTypes,
    verified: lookup.verified,
    project_uuid: lookup.project_uuid,
  }}
}

// ============================================================
// 状态机 API — 手动状态流转 / 查询状态 / 查询轮次
// ============================================================

// POST /review/:review_uuid/transition — 手动触发状态流转
export async function transitionReview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  // 方案A：用真实身份
  const operator_uuid = getOperator(req)
  const { target_state, reason } = b
  if (!rid || !target_state || !operator_uuid) {
    return { body: { error: '缺少必要字段' }, statusCode: 400 }
  }
  if (!REVIEW_STATES.includes(target_state as any)) {
    return { body: { error: `无效的目标状态: ${target_state}` }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  const currentState = getEffectiveState(rv)
  if (!isValidTransition(currentState, target_state)) {
    return { body: { error: `非法状态流转: ${currentState} → ${target_state}` }, statusCode: 400 }
  }

  // 外部通用状态接口只保留“整改完成后发起复审”这一业务命令。
  // 其他状态必须由 startReview / publishResolution / recallReview 等专用入口产生。
  if (target_state !== 're_reviewing' || currentState !== 'remediation_pending') {
    await writeAudit(rid, operator_uuid, '非法状态流转', target_state,
      `${currentState} → ${target_state}`, 'denied')
    return { body: { code: 'STATE_TRANSITION_NOT_ALLOWED', error: '该状态只能通过对应业务操作产生' }, statusCode: 403 }
  }

  // 权限校验：仅发起人可手动流转
  if ((rv as any).creator_uuid !== operator_uuid) {
    return { body: { error: '仅评审发起人可触发状态流转' }, statusCode: 403 }
  }

  // 进入 re_reviewing 时：校验整改项全部完成 + 重置评审人提交状态（开启新轮次）
  let extra: Record<string, any> = {}
  if (target_state === 're_reviewing') {
    // 校验：所有整改项必须已完成
    const remediationItems = await qAll(linkedIssue,
      (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
    if (remediationItems.length === 0) {
      return { body: { error: '没有可核验的整改项，不可发起复审' }, statusCode: 400 }
    }
    const tuid = getParam(req, 'team_uuid')
    if (!tuid) {
      return { body: { code: 'REMEDIATION_STATUS_UNKNOWN', error: '无法获取 ONES 团队上下文，不能确认整改状态' }, statusCode: 409 }
    }
    for (const item of remediationItems) await refreshRemediationItem(tuid, item)
    const syncedItems = await qAll(linkedIssue,
      (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
    const summary = summarizeRemediation(syncedItems)
    if (summary.state !== 'done') {
      return {
        body: {
          code: summary.state === 'unknown' ? 'REMEDIATION_STATUS_UNKNOWN' : 'REMEDIATION_NOT_DONE',
          error: summary.state === 'unknown' ? '仍有整改项无法通过 ONES 权威状态确认' : `仍有 ${syncedItems.length - summary.doneCount} 个整改项未完成`,
          pending: syncedItems.filter((v: any) => storedIssueCompletion(v) !== 'done').map((v: any) => v.issue_title || v.issue_uuid),
        },
        statusCode: 409,
      }
    }

    const newRoundNo = ((rv as any).round_no || 1) + 1
    // 优先查实体，兜底快照
    const snapRvrs = jsonArr((rv as any).reviewers_json || '[]')
    const entityRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
    const allReviewers = entityRvrs.length > 0 ? entityRvrs : snapRvrs
    // 更新快照 JSON
    const resetReviewers = allReviewers.map((r: any) => ({
      ...r, round_no: newRoundNo, conclusion: '', risk_level: '', opinion_summary: '', submitted_at: 0,
    }))
    extra.reviewers_json = JSON.stringify(resetReviewers)
    // 同步重置 rvReviewer 实体（submitOpinion / listMyReviews 优先读实体）
    for (const r of entityRvrs) {
      const { _key, ...rest } = r
      await rvReviewer.set(r._key, {
        ...rest,
        round_no: newRoundNo,
        submitted_at: 0,
        conclusion: '',
        risk_level: '',
        opinion_summary: '',
      })
    }
    // 重置 checklist
    let cl = jsonArr((rv as any).checklist_json || '[]')
    for (const item of cl) { item.status = 'unchecked'; item.checked_by = ''; item.checked_at = 0 }
    extra.checklist_json = JSON.stringify(cl)
  }

  const stateFields = buildStateTransition(rv, target_state, operator_uuid, reason || `手动流转: ${currentState} → ${target_state}`, extra)
  await review.set(rid, cleanForSet({ ...rv, ...stateFields }))
  await writeAudit(rid, operator_uuid, '状态流转', target_state,
    `${currentState} → ${target_state}${reason ? ' | ' + reason : ''}`)

  // 进入复审时通知评审人（与 startReview 一致）
  if (target_state === 're_reviewing') {
    const notCfg = await getNotifyConfig()
    if (notCfg.enabled && notCfg.on_review_start) {
      let _rule: any
      try { _rule = await getResolutionRuleForReview(rv) } catch { _rule = null }
      const _pubRole = _rule ? getPublisherRole(_rule) : ''
      const _snapRvrs = jsonArr((rv as any).reviewers_json || '[]')
      const _entityRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
      const _allRvrs = _entityRvrs.length > 0 ? _entityRvrs : _snapRvrs
      const reviewerUuids = _allRvrs
        .filter((r: any) => r.role_name !== _pubRole)
        .map((r: any) => r.reviewer_uuid)
        .filter(Boolean)
      if (reviewerUuids.length > 0) {
        const phaseName = (rv as any).phase_code || ''
        const reviewTitle = (rv as any).review_title || '评审'
        await sendNotification(
          `复审通知 — ${phaseName}`,
          `「${phaseName} ${reviewTitle}」已进入第${stateFields.round_no}轮复审，请前往评审工作台重新提交评审意见。`,
          `${(rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : ''}`,
          reviewerUuids,
        )
      }
    }
  }

  return {
    body: {
      ok: true,
      review_state: target_state,
      status: stateToStatus(target_state),
      round_no: stateFields.round_no,
      round_state: stateToRoundState(target_state),
      previous_state: currentState,
    }
  }
}

// GET /review/:review_uuid/state — 查询完整状态信息
export async function getReviewState(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  const currentState = getEffectiveState(rv)
  const history = jsonArr((rv as any).state_history_json || '[]')

  // 可流转到的目标状态
  const availableTransitions = currentState === 'remediation_pending' ? ['re_reviewing'] : []

  return {
    body: {
      review_uuid: rid,
      review_state: currentState,
      status: (rv as any).status,
      round_no: Number((rv as any).round_no || 1),
      round_state: (rv as any).round_state || stateToRoundState(currentState),
      state_history: history,
      available_transitions: availableTransitions,
    }
  }
}

// GET /review/:review_uuid/rounds — 查询轮次信息
export async function getReviewRounds(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  const history = jsonArr((rv as any).state_history_json || '[]')
  const currentRoundNo = Number((rv as any).round_no || 1)

  // 从状态历史中提取轮次信息
  const rounds: any[] = []
  let currentRound: any = null
  for (const entry of history) {
    const rno = Number(entry.round_no || 1)
    if (!currentRound || currentRound.round_no !== rno) {
      if (currentRound) rounds.push(currentRound)
      currentRound = {
        round_no: rno,
        started_at: entry.at,
        started_by: entry.by,
        start_state: entry.state,
        states: [entry],
      }
    } else {
      currentRound.states.push(entry)
      currentRound.end_state = entry.state
      currentRound.ended_at = entry.at
    }
  }
  if (currentRound) rounds.push(currentRound)

  // 获取每轮的决议快照
  // 旧数据兼容：v1.22.0 前的决议无 round_no 字段，从 _key 推断（key 格式: rid=第1轮, rid_rN=第N轮）
  const resolutions = await qAll(resolution, (v: any) => v.review_uuid === rid)
  const resRoundNo = (res: any): number => {
    if (res.round_no) return Number(res.round_no)
    const m = (res._key || '').match(/_r(\d+)$/)
    return m ? Number(m[1]) : 1
  }

  return {
    body: {
      review_uuid: rid,
      current_round_no: currentRoundNo,
      current_round_state: (rv as any).round_state || stateToRoundState(getEffectiveState(rv)),
      total_rounds: rounds.length,
      rounds: rounds.map((r: any) => ({
        round_no: r.round_no,
        started_at: r.started_at,
        ended_at: r.ended_at || 0,
        start_state: r.start_state,
        end_state: r.end_state || r.start_state,
        state_count: r.states.length,
        resolution: resolutions.find((res: any) => resRoundNo(res) === r.round_no) || null,
      })),
    }
  }
}

// ============================================================
// 事件处理 — 工作项状态变更（整改闭环被动通知）
// ============================================================

function parseEvent(payload: any) {
  const evt = payload?.body?.eventID ? payload.body : (payload?.eventID ? payload : {})
  const ctx = evt?.eventContext || {}
  return {
    eventID: evt?.eventID || '',
    teamUUID: ctx?.teamID || '',
    userUUID: ctx?.triggerUserID || '',
    timestamp: evt?.timestamp || Date.now(),
    data: evt?.eventData || {},
  }
}

// 兼容旧数据：旧版本把已完成状态名替换为 'done' 或硬编码 'open'，读取时还原
function normalizeIssueStatus(status: string): string {
  if (status === 'done') return '已完成'
  if (status === 'open') return ''
  return status || ''
}

type IssueCompletionState = 'done' | 'not_done' | 'unknown'

function categoryToCompletion(category: any): IssueCompletionState {
  if (typeof category === 'number') return category === 2 ? 'done' : 'not_done'
  if (typeof category === 'string') {
    const normalized = category.toLowerCase()
    if (normalized === '2' || normalized === 'done' || normalized === 'closed' || normalized === 'completed') return 'done'
    if (normalized === '0' || normalized === '1' || normalized === 'to_do' || normalized === 'todo' || normalized === 'in_progress' || normalized === 'open') return 'not_done'
  }
  return 'unknown'
}

function storedIssueCompletion(item: any): IssueCompletionState {
  if (item?.issue_status_verification !== 'verified') return 'unknown'
  return item?.issue_status_is_done === true ? 'done' : 'not_done'
}

function summarizeRemediation(items: any[]): { state: IssueCompletionState; doneCount: number; unknownCount: number } {
  if (items.length === 0) return { state: 'unknown', doneCount: 0, unknownCount: 0 }
  let doneCount = 0
  let unknownCount = 0
  for (const item of items) {
    const state = storedIssueCompletion(item)
    if (state === 'done') doneCount++
    if (state === 'unknown') unknownCount++
  }
  return {
    state: unknownCount > 0 ? 'unknown' : doneCount === items.length ? 'done' : 'not_done',
    doneCount,
    unknownCount,
  }
}

async function fetchIssueStatus(teamUUID: string, issueUUID: string): Promise<any | null> {
  if (!teamUUID || !issueUUID) return null
  try {
    const query = `query findTasks($filter: TasksFilter) { tasks(filter: $filter) { uuid status { uuid name category } } }`
    const res = await OPFetch(
      `/project/api/project/team/${teamUUID}/items/graphql?t=dcpIssueStatus`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { query, variables: { filter: { uuid_in: [issueUUID] } } },
        teamUUID,
      } as any,
    ) as any
    const tasks = res?.data?.tasks || res?.data?.data?.tasks || res?.tasks || []
    const task = Array.isArray(tasks) ? tasks.find((v: any) => v.uuid === issueUUID) : null
    if (!task?.status) return null
    return {
      issue_uuid: issueUUID,
      status_id: task.status.uuid || task.status.id || '',
      status_name: task.status.name || '',
      category: task.status.category,
      completion: categoryToCompletion(task.status.category),
    }
  } catch (e: any) {
    Logger.info(`[DCP] issue status lookup unavailable: ${e?.message || e}`)
    return null
  }
}

function issueStatusFields(info: any, source: string, error = ''): Record<string, any> {
  const completion = info?.completion || 'unknown'
  return {
    issue_status: info?.status_name || '',
    issue_status_id: info?.status_id || '',
    issue_status_category: info?.category === undefined || info?.category === null ? '' : String(info.category),
    issue_status_is_done: completion === 'done',
    issue_status_verification: completion === 'unknown' ? 'unknown' : 'verified',
    issue_status_source: source,
    issue_status_checked_at: Date.now(),
    issue_status_error: error || '',
  }
}

async function refreshRemediationItem(teamUUID: string, item: any): Promise<any> {
  const info = await fetchIssueStatus(teamUUID, item.issue_uuid)
  const fields = info
    ? issueStatusFields(info, 'server_api')
    : {
      issue_status_verification: 'unknown',
      issue_status_source: 'unverified',
      issue_status_checked_at: Date.now(),
      issue_status_error: '无法从 ONES 权威接口确认工作项状态',
    }
  const { _key, ...rest } = item
  await linkedIssue.set(item._key, { ...rest, ...fields })
  return { ...item, ...fields }
}

// 事件 handler — 工作项状态变更
export async function onIssueStatusChanged(payload: any) {
  try {
    const evt = parseEvent(payload)
    const data = evt.data as any
    const teamUUID = evt.teamUUID
    const issueID = data?.issueID || ''
    const newStatus = data?.newStatus || {}
    if (!issueID) return { body: {} }

    // 检查是否是整改关联工作项
    const items = await qAll(linkedIssue,
      (v: any) => v.issue_uuid === issueID && v.link_type === 'remediation')
    if (items.length === 0) return { body: {} }

    // 事件中的 category 是 ONES 权威状态；缺失时不猜测，标记为 unknown。
    let eventInfo: any = {
      status_id: newStatus.id || newStatus.uuid || '',
      status_name: newStatus.name || '',
      category: newStatus.category,
      completion: categoryToCompletion(newStatus.category),
    }
    if (eventInfo.completion === 'unknown') {
      eventInfo = await fetchIssueStatus(teamUUID, issueID) || eventInfo
    }
    const completion = eventInfo.completion as IssueCompletionState

    // 更新快照（通常只有一条记录）
    for (const item of items) {
      const fields = issueStatusFields(eventInfo, 'event')
      await linkedIssue.set(item._key, {
        ...item, ...fields,
      })
    }

    // 如果是已完成，检查该评审单所有整改项是否全部完成
    if (completion === 'done') {
      const rid = items[0].review_uuid
      const allRemediation = await qAll(linkedIssue,
        (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
      const allDone = summarizeRemediation(allRemediation).state === 'done'

      if (allDone) {
        // 通知决议人 + 评审发起人
        const rv = await review.get(rid)
        if (rv) {
          const resolutions = await qAll(resolution, (v: any) => v.review_uuid === rid)
          const publisherUUID = resolutions[0]?.published_by || ''
          const creatorUUID = (rv as any).creator_uuid || ''
          // 合并通知对象（去重）
          const notifyTargets = [...new Set([publisherUUID, creatorUUID].filter(Boolean))] as string[]

          const notCfg = await getNotifyConfig()
          if (notCfg.enabled && notifyTargets.length > 0) {
            const phaseName = (rv as any).phase_code || ''
            const title = (rv as any).review_title || phaseName
            await sendNotification(
              `${((rv as any).review_type || 'dcp').toUpperCase()}评审整改完成 — ${phaseName}`,
              `「${title}」的 ${allRemediation.length} 个整改工作项已全部完成，请确认并发起复审。`,
              (rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : '',
              notifyTargets,
            )
          }
        }
      }
    }
  } catch (e: any) {
    Logger.error(`[DCP] onIssueStatusChanged error: ${e?.message || e}`)
  }
  return { body: {} }
}

// ============================================================
// 整改闭环 — 查询 / 刷新 / 确认
// ============================================================

// GET /review/:review_uuid/remediation — 查询整改关联工作项
export async function getRemediationIssues(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }

  const items = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
  items.sort((a: any, b: any) => (a.linked_at || 0) - (b.linked_at || 0))

  const summary = summarizeRemediation(items)
  const itemsNormalized = items.map((v: any) => ({ ...v, issue_status: normalizeIssueStatus(v.issue_status) }))

  return {
    body: {
      items: itemsNormalized,
      total: itemsNormalized.length,
      done_count: summary.doneCount,
      unknown_count: summary.unknownCount,
      status_state: summary.state,
      all_done: summary.state === 'done',
    }
  }
}

// POST /review/:review_uuid/remediation/refresh — 手动刷新整改项状态（兜底，OPFetch 不可达时无效）
export async function refreshRemediationStatus(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const tuid = getParam(req, 'team_uuid')
  if (!tuid) return { body: { error: '无法获取 team_uuid' }, statusCode: 400 }

  const items = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')

  for (const item of items) await refreshRemediationItem(tuid, item)

  const updated = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
  const summary = summarizeRemediation(updated)
  const updatedNormalized = updated.map((v: any) => ({ ...v, issue_status: normalizeIssueStatus(v.issue_status) }))

  return {
    body: {
      items: updatedNormalized,
      total: updatedNormalized.length,
      done_count: summary.doneCount,
      unknown_count: summary.unknownCount,
      status_state: summary.state,
      all_done: summary.state === 'done',
    }
  }
}

// POST /review/:review_uuid/remediation/sync — 客户端状态仅作观察值，服务端验证成功后才写权威完成状态
export async function syncRemediationStatus(req: any): Promise<PluginResponse> {
  try {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const tuid = getParam(req, 'team_uuid')
  const b = (req.body || {}) as any
  const items: Array<{ issue_uuid: string; status_name?: string; status_id?: string; category?: string | number; is_done?: boolean }> = b.items || []
  if (!Array.isArray(items) || items.length === 0) {
    return { body: { error: '缺少 items 数组' }, statusCode: 400 }
  }

  // 读取当前所有整改关联项
  const allLinked = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')

  let updatedCount = 0
  for (const item of items) {
    const linked = allLinked.find((l: any) => l.issue_uuid === item.issue_uuid)
    if (!linked) continue

    // 客户端状态只能作为观察值；完成与否必须由服务端重新从 ONES 校验。
    const authoritative = tuid ? await fetchIssueStatus(tuid, item.issue_uuid) : null
    const fields = authoritative
      ? issueStatusFields(authoritative, 'server_api')
      : linked.issue_status_verification === 'verified'
        ? {
          issue_status: linked.issue_status || '',
          issue_status_id: linked.issue_status_id || '',
          issue_status_category: linked.issue_status_category || '',
          issue_status_is_done: linked.issue_status_is_done === true,
          issue_status_verification: 'verified',
          issue_status_source: linked.issue_status_source || 'event',
          issue_status_checked_at: linked.issue_status_checked_at || 0,
          issue_status_error: '',
        }
      : {
        issue_status: item.status_name || linked.issue_status || '',
        issue_status_id: item.status_id || linked.issue_status_id || '',
        issue_status_category: item.category === undefined ? (linked.issue_status_category || '') : String(item.category),
        issue_status_verification: 'unknown',
        issue_status_source: 'client_observed',
        issue_status_checked_at: Date.now(),
        issue_status_error: '客户端状态未通过服务端权威校验',
      }
    const { _key, ...rest } = linked
    await linkedIssue.set(linked._key, { ...rest, ...fields })
    if (linked.issue_status !== fields.issue_status || linked.issue_status_verification !== fields.issue_status_verification) {
      updatedCount++
    }
  }

  // 返回更新后的数据
  const updated = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
  const summary = summarizeRemediation(updated)
  const allDone = summary.state === 'done'

  // 全部整改项刚完成时通知决议人 + 评审发起人
  if (allDone && updatedCount > 0) {
    try {
      const rv = await review.get(rid)
      if (rv) {
        const resolutions = await qAll(resolution, (v: any) => v.review_uuid === rid)
        const publisherUUID = resolutions[0]?.published_by || ''
        const creatorUUID = (rv as any).creator_uuid || ''
        const notifyTargets = [...new Set([publisherUUID, creatorUUID].filter(Boolean))] as string[]
        const notCfg = await getNotifyConfig()
        if (notCfg.enabled && notifyTargets.length > 0) {
          const phaseName = (rv as any).phase_code || ''
          const title = (rv as any).review_title || phaseName
          await sendNotification(
            `${((rv as any).review_type || 'dcp').toUpperCase()}评审整改完成 — ${phaseName}`,
            `「${title}」的 ${updated.length} 个整改工作项已全部完成，请确认并发起复审。`,
            (rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : '',
            notifyTargets,
          )
        }
      }
    } catch (e: any) {
      Logger.error(`[DCP] syncRemediationStatus notify error: ${e?.message || e}`)
    }
  }

  return {
    body: {
      ok: true,
      updated_count: updatedCount,
      items: updated.map((v: any) => ({ ...v, issue_status: normalizeIssueStatus(v.issue_status) })),
      total: updated.length,
      done_count: summary.doneCount,
      unknown_count: summary.unknownCount,
      status_state: summary.state,
      all_done: allDone,
    }
  }
  } catch (e: any) {
    Logger.error(`[DCP] syncRemediationStatus error: ${e?.message || e}`, e?.stack || '')
    return { body: { error: `同步失败: ${e?.message || e}` }, statusCode: 500 }
  }
}

// POST /review/:review_uuid/remediation/confirm — 决议人确认整改完成
export async function confirmRemediation(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  if (!rid) return { body: { error: '缺少 review_uuid' }, statusCode: 400 }
  const tuid = getParam(req, 'team_uuid')
  const b = (req.body || {}) as any
  // 方案A+B：用真实身份，publisher_uuid 必须与当前登录用户一致
  const _confirmOp = getOperator(req)
  const publisher_uuid = _confirmOp || b.publisher_uuid || ''
  const { next_action } = b
  // 校验：publisher_uuid 必须与真实身份一致
  if (_confirmOp && b.publisher_uuid && _confirmOp !== b.publisher_uuid) {
    return { body: { error: '只能以本人身份确认整改' }, statusCode: 403 }
  }
  // next_action: 're_review'（整改完成后只能发起复审，不能直接通过）
  if (!publisher_uuid) return { body: { error: '缺少 publisher_uuid' }, statusCode: 400 }
  if (!next_action || next_action !== 're_review') {
    return { body: { error: '整改完成后只能发起复审，请使用评审单顶部的「开始复审」按钮' }, statusCode: 400 }
  }

  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }

  const effState = getEffectiveState(rv)
  if (effState !== 'remediation_pending') {
    return { body: { error: '当前状态不可确认整改' }, statusCode: 400 }
  }

  // 校验：至少有一个整改项
  const items = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')
  if (items.length === 0) {
    return { body: { error: '请先创建或关联整改工作项' }, statusCode: 400 }
  }

  // 实时同步整改项状态；不能依赖事件快照或客户端传入的 is_done。
  if (!tuid) {
    return { body: { code: 'REMEDIATION_STATUS_UNKNOWN', error: '无法获取 ONES 团队上下文，不能确认整改状态' }, statusCode: 409 }
  }
  for (const item of items) await refreshRemediationItem(tuid, item)

  // 重新读取同步后的整改项
  const syncedItems = await qAll(linkedIssue,
    (v: any) => v.review_uuid === rid && v.link_type === 'remediation')

  // 校验：所有整改项已完成
  const summary = summarizeRemediation(syncedItems)
  const notDone = syncedItems.filter((v: any) => storedIssueCompletion(v) !== 'done')
  if (summary.state !== 'done') {
    return {
      body: {
        code: summary.state === 'unknown' ? 'REMEDIATION_STATUS_UNKNOWN' : 'REMEDIATION_NOT_DONE',
        error: summary.state === 'unknown' ? '仍有整改项无法通过 ONES 权威状态确认' : `仍有 ${notDone.length} 个整改项未完成`,
        pending: notDone.map((v: any) => v.issue_title || v.issue_uuid),
      },
      statusCode: 409
    }
  }

  const now = Date.now()

  // 1. 给每个整改工作项发评论（备注）
  if (tuid) {
    const reviewNumber = (rv as any).review_number || rid
    const targetRoundNo = Number((rv as any).round_no || 1) + 1
    const commentText = `整改已确认完成，评审进入第 ${targetRoundNo} 轮复审（评审单 ${reviewNumber}）。`
    for (const item of syncedItems) {
      try {
        await OPFetch(
          `/project/api/project/team/${tuid}/items/graphql?t=addComment`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            teamUUID: tuid,
            data: {
              query: `mutation { addComment(input: { issueID: "${item.issue_uuid}", content: "${commentText.replace(/"/g, '\\"')}" }) { success } }`,
            },
          }
        )
      } catch (e: any) {
        Logger.error(`[DCP] addComment for ${item.issue_uuid} failed: ${e?.message || e}`)
      }
    }
  }

  // 2. 评审单状态流转（整改完成后只能发起复审）
  const targetState = 're_reviewing'
  const reason = '整改完成，发起复审'

  // 如果是复审，round_no + 1，重置 reviewers_json 中评审人 submitted_at
  let newRoundNo = (rv as any).round_no || 1
  let newReviewersJson = (rv as any).reviewers_json || '[]'
  if (next_action === 're_review') {
    newRoundNo = newRoundNo + 1
    const snap = jsonArr(newReviewersJson)
    newReviewersJson = JSON.stringify(snap.map((r: any) => ({
      ...r,
      round_no: newRoundNo,
      submitted_at: 0,
      conclusion: '',
      risk_level: '',
      opinion_summary: '',
    })))
    // 同步重置 rvReviewer 实体（submitOpinion / listMyReviews 优先读实体）
    const entityRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
    for (const r of entityRvrs) {
      const { _key, ...rest } = r
      await rvReviewer.set(r._key, {
        ...rest,
        round_no: newRoundNo,
        submitted_at: 0,
        conclusion: '',
        risk_level: '',
        opinion_summary: '',
      })
    }
  }

  const stateFields = buildStateTransition(rv, targetState, publisher_uuid, reason)
  // 复审时重置 checklist
  if (next_action === 're_review') {
    let cl = jsonArr((rv as any).checklist_json || '[]')
    for (const item of cl) { item.status = 'unchecked'; item.checked_by = ''; item.checked_at = 0 }
    stateFields.checklist_json = JSON.stringify(cl)
  }
  await review.set(rid, cleanForSet({
    ...rv,
    ...stateFields,
    round_no: newRoundNo,
    reviewers_json: newReviewersJson,
  }))

  await writeAudit(rid, publisher_uuid, '确认整改完成', rid,
    `整改项 ${syncedItems.length} 个全部完成，${next_action === 're_review' ? '进入复审' : '评审完成'}`)

  // 4. 通知配置复用于后续复审通知
  const notCfg = await getNotifyConfig()

  // 5. 复审时通知评审人重新提交评审意见
  if (next_action === 're_review' && notCfg.enabled && notCfg.on_review_start) {
    let _rule: any
    try { _rule = await getResolutionRuleForReview(rv) } catch { _rule = null }
    const _pubRole = _rule ? getPublisherRole(_rule) : ''
    const _snapRvrs = jsonArr(newReviewersJson)
    const _entityRvrs = await qAll(rvReviewer, (v: any) => v.review_uuid === rid)
    const _allRvrs = _entityRvrs.length > 0 ? _entityRvrs : _snapRvrs
    const reviewerUuids = _allRvrs
      .filter((r: any) => r.role_name !== _pubRole)
      .map((r: any) => r.reviewer_uuid)
      .filter(Boolean)
    if (reviewerUuids.length > 0) {
      const phaseName = (rv as any).phase_code || ''
      const reviewTitle = (rv as any).review_title || '评审'
      await sendNotification(
        `复审通知 — ${phaseName}`,
        `「${phaseName} ${reviewTitle}」整改已完成，进入第${newRoundNo}轮复审，请前往评审工作台重新提交评审意见。`,
        (rv as any).project_uuid ? `/project/${(rv as any).project_uuid}` : '',
        reviewerUuids,
      )
    }
  }

  return { body: { ok: true, review_state: targetState, round_no: newRoundNo } }
}

// ============================================================
// Reviewer Profile — 评审人 Profile 管理
// ============================================================

// ============================================================
// Reviewer Profile — 角色分配模型
//
// 每个 Profile 的 role_assignments_json 是角色分配数组：
//   { role_name, mode: 'single'|'pool', default_reviewer?: uuid, candidate_uuids?: uuid[] }
//
// single 模式：创建评审单时自动填入 default_reviewer，updateReviewers 时仅接受该人选
// pool  模式：创建时不自动填入，updateReviewers 时限制候选范围为 candidate_uuids
// ============================================================

type ReviewerAssignmentRow = {
  role_name: string
  reviewer_uuid: string
  selection_mode: 'single' | 'pool'
  default_reviewer_uuid: string
  candidate_uuids_json: string
}

function normalizeRoleAssignments(roleAssignments: any[]): any[] {
  return (roleAssignments || []).map((ra: any) => ({
    role_name: String(ra.role_name || ''),
    mode: ra.mode === 'pool' ? 'pool' : 'single',
    default_reviewer_uuid: String(ra.default_reviewer_uuid || ra.default_reviewer || ''),
    candidate_uuids: Array.isArray(ra.candidate_uuids) ? [...new Set(ra.candidate_uuids.filter((u: any) => !!u).map((u: any) => String(u)))] : [],
  }))
}

// 解析角色分配，返回会写入评审单的评审人快照行
function resolveAutoReviewers(roleAssignments: any[], roleTemplates: any[]): ReviewerAssignmentRow[] {
  const roleNames = new Set(roleTemplates.map((r: any) => r.role_name))
  const autoReviewers: ReviewerAssignmentRow[] = []
  for (const ra of normalizeRoleAssignments(roleAssignments)) {
    if (!ra.role_name || !roleNames.has(ra.role_name)) continue
    // 候选池只是可选范围，在发起人真正选择成员前不创建空评审人实体。
    if (ra.mode !== 'single' || !ra.default_reviewer_uuid) continue
    autoReviewers.push({
      role_name: ra.role_name,
      reviewer_uuid: ra.default_reviewer_uuid,
      selection_mode: 'single',
      default_reviewer_uuid: ra.default_reviewer_uuid,
      candidate_uuids_json: JSON.stringify([ra.default_reviewer_uuid]),
    })
  }
  return autoReviewers
}

// 将评审人写入实体（内部函数，被 createReview / updateReviewers / applyProfileToReview 共用）
async function writeReviewersToEntities(rvUuid: string, reviewers: ReviewerAssignmentRow[], roleTemplates: any[], rv: any): Promise<any[]> {
  // 删除旧评审人
  const old = await qAll(rvReviewer, (v: any) => v.review_uuid === rvUuid)
  for (const o of old) await rvReviewer.delete(o._key)

  // 按 sort_order 排序
  const ordered = reviewers.sort((a, b) => {
    const ai = roleTemplates.find((rt: any) => rt.role_name === a.role_name)?.sort_order ?? 9999
    const bi = roleTemplates.find((rt: any) => rt.role_name === b.role_name)?.sort_order ?? 9999
    return ai - bi
  })

  // 写入新评审人
  const savedPayload: any[] = []
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]
    const key = `${rvUuid}_rvr_${i}`
    const value = {
      review_uuid: rvUuid, reviewer_uuid: r.reviewer_uuid, role_name: r.role_name,
      selection_mode: r.selection_mode,
      default_reviewer_uuid: r.default_reviewer_uuid,
      candidate_uuids_json: r.candidate_uuids_json,
      conclusion: '', risk_level: 'medium', opinion_summary: '', submitted_at: 0,
    }
    await rvReviewer.set(key, value)
    savedPayload.push({ _key: key, ...value })
  }

  return savedPayload
}

// 校验角色分配中同一用户是否担任多个角色（single 模式 default 互查 + pool 候选去重）
function validateRoleAssignmentsNoDupUsers(roleAssignments: any[]): string | null {
  const uuidToRoles: Record<string, string[]> = {}
  for (const ra of normalizeRoleAssignments(roleAssignments)) {
    if (ra.mode === 'single' && ra.default_reviewer_uuid) {
      if (!uuidToRoles[ra.default_reviewer_uuid]) uuidToRoles[ra.default_reviewer_uuid] = []
      uuidToRoles[ra.default_reviewer_uuid].push(ra.role_name)
    }
    if (ra.mode === 'pool' && Array.isArray(ra.candidate_uuids)) {
      for (const uid of ra.candidate_uuids) {
        if (!uid) continue
        if (!uuidToRoles[uid]) uuidToRoles[uid] = []
        if (!uuidToRoles[uid].includes(ra.role_name)) uuidToRoles[uid].push(ra.role_name)
      }
    }
  }
  const multiRoleUsers = Object.entries(uuidToRoles).filter(([, roles]) => roles.length > 1)
  if (multiRoleUsers.length > 0) {
    return multiRoleUsers.map(([uuid, roles]) => `${uuid}(${roles.join('/')})`).join('、')
  }
  return null
}

// 校验提交的评审人是否在 profile 快照允许范围内（updateReviewers 调用）
function validateReviewersAgainstProfileSnapshot(reviewers: Array<{role_name: string; reviewer_uuid: string}>, profileSnapshot: any[], roleTemplates: any[]): string | null {
  const snapByRole = new Map<string, any>()
  for (const ra of profileSnapshot) {
    if (ra.role_name) snapByRole.set(ra.role_name, ra)
  }
  const roleNames = new Set(roleTemplates.map((r: any) => r.role_name))

  for (const rv of reviewers) {
    if (!rv.role_name || !rv.reviewer_uuid) continue
    if (!roleNames.has(rv.role_name)) continue

    const snap = snapByRole.get(rv.role_name)
    if (!snap) continue // 快照中没有该角色 → 允许自由选择（管理员后来加了新角色）

    if (snap.mode === 'single') {
      if (snap.default_reviewer_uuid && rv.reviewer_uuid !== snap.default_reviewer_uuid) {
        return `角色「${rv.role_name}」绑定了指定评审人，不可更换为其他人`
      }
    } else if (snap.mode === 'pool') {
      const candidates: string[] = snap.candidate_uuids || []
      if (candidates.length > 0 && !candidates.includes(rv.reviewer_uuid)) {
        return `角色「${rv.role_name}」的评审人必须在候选池中选择`
      }
    }
  }
  return null
}

// GET /dcp/reviewer-profiles?review_type=dcp
export async function listReviewerProfiles(req: any): Promise<PluginResponse> {
  const rvType = getParam(req, 'review_type') || ''
  const profiles = rvType
    ? await qAll(reviewerProfile, (v: any) => (v.review_type || 'dcp') === rvType)
    : await qAll(reviewerProfile)
  profiles.sort((a: any, b: any) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))
  return { body: { profiles } }
}

// POST /dcp/reviewer-profile
// 角色分配模型：每个条目 { role_name, mode: 'single'|'pool', default_reviewer_uuid?, candidate_uuids[]? }
export async function createReviewerProfile(req: any): Promise<PluginResponse> {
  const b = (req.body || {}) as any
  const operatorUuid = getOperator(req)
  const { profile_name, review_type, description, role_assignments } = b
  if (!profile_name || !profile_name.trim()) {
    return { body: { error: 'Profile 名称不能为空' }, statusCode: 400 }
  }
  const rvType = review_type || 'dcp'
  const now = Date.now()
  const profileId = makeUuid()
  const assignments = Array.isArray(role_assignments) ? role_assignments : []
  // 校验：每个条目必须有 role_name 和 mode
  for (const ra of assignments) {
    if (!ra.role_name) {
      return { body: { error: '每个角色分配必须包含 role_name' }, statusCode: 400 }
    }
    if (ra.mode !== 'single' && ra.mode !== 'pool') {
      return { body: { error: `角色「${ra.role_name}」的 mode 必须为 single 或 pool` }, statusCode: 400 }
    }
    if (ra.mode === 'single' && !ra.default_reviewer_uuid) {
      return { body: { error: `角色「${ra.role_name}」为 single 模式，必须指定 default_reviewer_uuid` }, statusCode: 400 }
    }
  }
  // 校验：同一用户不担任多个角色
  const dupErr = validateRoleAssignmentsNoDupUsers(assignments)
  if (dupErr) {
    return { body: { error: `同一用户不能同时担任多个角色：${dupErr}` }, statusCode: 400 }
  }
  await reviewerProfile.set(profileId, {
    profile_name: profile_name.trim(),
    review_type: rvType,
    description: description || '',
    role_assignments_json: JSON.stringify(assignments),
    created_by: operatorUuid || '',
    created_at: now,
    updated_at: now,
  })
  Logger.info(`[DCP] ReviewerProfile created: ${profileId} by ${operatorUuid}`)
  return { body: { profile_id: profileId, profile_name: profile_name.trim() } }
}

// GET /dcp/reviewer-profile/:profile_id
export async function getReviewerProfile(req: any): Promise<PluginResponse> {
  const pid = getParam(req, 'profile_id')
  if (!pid) return { body: { error: '缺少 profile_id' }, statusCode: 400 }
  const p = await reviewerProfile.get(pid)
  if (!p) return { body: { error: 'Profile 不存在' }, statusCode: 404 }
  return { body: { ...p, role_assignments: jsonArr((p as any).role_assignments_json || '[]') } }
}

// PUT /dcp/reviewer-profile/:profile_id
export async function updateReviewerProfile(req: any): Promise<PluginResponse> {
  const pid = getParam(req, 'profile_id')
  const b = (req.body || {}) as any
  const operatorUuid = getOperator(req)
  if (!pid) return { body: { error: '缺少 profile_id' }, statusCode: 400 }
  const p = await reviewerProfile.get(pid)
  if (!p) return { body: { error: 'Profile 不存在' }, statusCode: 404 }
  const { profile_name, review_type, description, role_assignments } = b
  const assignments = Array.isArray(role_assignments) ? role_assignments : []
  // 校验
  for (const ra of assignments) {
    if (!ra.role_name) {
      return { body: { error: '每个角色分配必须包含 role_name' }, statusCode: 400 }
    }
    if (ra.mode !== 'single' && ra.mode !== 'pool') {
      return { body: { error: `角色「${ra.role_name}」的 mode 必须为 single 或 pool` }, statusCode: 400 }
    }
  }
  const dupErr = validateRoleAssignmentsNoDupUsers(assignments)
  if (dupErr) {
    return { body: { error: `同一用户不能同时担任多个角色：${dupErr}` }, statusCode: 400 }
  }
  const now = Date.now()
  await reviewerProfile.set(pid, {
    ...(p as any),
    profile_name: profile_name?.trim() || (p as any).profile_name,
    review_type: review_type || (p as any).review_type || 'dcp',
    description: description !== undefined ? description : (p as any).description,
    role_assignments_json: b.role_assignments !== undefined ? JSON.stringify(assignments) : (p as any).role_assignments_json,
    updated_at: now,
  })
  Logger.info(`[DCP] ReviewerProfile updated: ${pid} by ${operatorUuid}`)
  return { body: { ok: true } }
}

// DELETE /dcp/reviewer-profile/:profile_id
export async function deleteReviewerProfile(req: any): Promise<PluginResponse> {
  const pid = getParam(req, 'profile_id')
  if (!pid) return { body: { error: '缺少 profile_id' }, statusCode: 400 }
  const p = await reviewerProfile.get(pid)
  if (!p) return { body: { error: 'Profile 不存在' }, statusCode: 404 }
  // 检查是否有项目绑定引用此 Profile
  const bindings = await qAll(projectBinding, (v: any) => v.profile_id === pid)
  if (bindings.length > 0) {
    return { body: { error: `此 Profile 已被 ${bindings.length} 个项目绑定，请先解除绑定再删除` }, statusCode: 400 }
  }
  await reviewerProfile.delete(pid)
  Logger.info(`[DCP] ReviewerProfile deleted: ${pid}`)
  return { body: { ok: true } }
}

// ============================================================
// Project Binding — 项目与 Profile 绑定
// ============================================================

// GET /dcp/project-bindings?project_uuid=xxx
export async function listProjectBindings(req: any): Promise<PluginResponse> {
  const puid = getQueryParam(req, 'project_uuid')
  const bindings = puid
    ? await qAll(projectBinding, (v: any) => v.project_uuid === puid)
    : await qAll(projectBinding)
  // 为每个 binding 补充 profile_name
  const enriched = await Promise.all(bindings.map(async (b: any) => {
    let profileName = ''
    try {
      const p = await reviewerProfile.get(b.profile_id)
      if (p) profileName = (p as any).profile_name || ''
    } catch { /* profile 可能已删除 */ }
    return { ...b, profile_name: profileName }
  }))
  return { body: { bindings: enriched } }
}

// POST /dcp/project-binding（upsert: 同一 project_uuid + review_type 覆盖）
export async function upsertProjectBinding(req: any): Promise<PluginResponse> {
  const b = (req.body || {}) as any
  const operatorUuid = getOperator(req)
  const { project_uuid, profile_id, review_type } = b
  if (!project_uuid || !profile_id) {
    return { body: { error: '缺少 project_uuid 或 profile_id' }, statusCode: 400 }
  }
  // 验证 Profile 存在
  const p = await reviewerProfile.get(profile_id)
  if (!p) return { body: { error: 'Profile 不存在' }, statusCode: 404 }
  const rvType = review_type || 'dcp'
  // 查找已有绑定（同 project + review_type）
  const existing = await qAll(projectBinding, (v: any) => v.project_uuid === project_uuid && (v.review_type || 'dcp') === rvType)
  const now = Date.now()
  let bindingId: string
  try {
    if (existing.length > 0) {
      // 更新已有绑定
      bindingId = existing[0]._key
      await projectBinding.set(bindingId, cleanForSet({
        ...existing[0],
        project_uuid,
        profile_id,
        review_type: rvType,
      }))
      Logger.info(`[DCP] ProjectBinding updated: ${bindingId} → ${profile_id}`)
    } else {
      // 新建绑定
      bindingId = makeUuid()
      await projectBinding.set(bindingId, cleanForSet({
        project_uuid, profile_id,
        review_type: rvType,
        created_by: operatorUuid || '',
        created_at: now,
      }))
      Logger.info(`[DCP] ProjectBinding created: ${bindingId}`)
    }
  } catch (error: any) {
    const message = formatError(error)
    Logger.error(`[DCP] ProjectBinding persistence failed: project=${project_uuid}, profile=${profile_id}, error=${message}`)
    return { body: { error: `项目绑定保存失败: ${message}` }, statusCode: 500 }
  }
  return { body: { binding_id: bindingId, project_uuid, profile_id, profile_name: (p as any).profile_name || '' } }
}

// DELETE /dcp/project-binding/:binding_id
export async function deleteProjectBinding(req: any): Promise<PluginResponse> {
  const bid = getParam(req, 'binding_id')
  if (!bid) return { body: { error: '缺少 binding_id' }, statusCode: 400 }
  try {
    await projectBinding.delete(bid)
    Logger.info(`[DCP] ProjectBinding deleted: ${bid}`)
  } catch (e: any) {
    return { body: { error: `删除失败: ${e?.message || e}` }, statusCode: 500 }
  }
  return { body: { ok: true } }
}

// ============================================================
// Apply Profile to Review — 将 Profile 评审人应用到评审单
// ============================================================

// POST /dcp/review/:review_uuid/apply-profile
export async function applyProfileToReview(req: any): Promise<PluginResponse> {
  const rid = getParam(req, 'review_uuid')
  const b = (req.body || {}) as any
  const operatorUuid = getOperator(req)
  const { profile_id } = b
  if (!rid || !profile_id) {
    return { body: { error: '缺少 review_uuid 或 profile_id' }, statusCode: 400 }
  }
  const rv = await review.get(rid)
  if (!rv) return { body: { error: '评审单不存在' }, statusCode: 404 }
  if (operatorUuid && (rv as any).creator_uuid && operatorUuid !== (rv as any).creator_uuid) {
    return { body: { error: '仅创建者可应用 Profile' }, statusCode: 403 }
  }
  if (rv.status !== 'draft') {
    return { body: { error: '评审已发起，不可修改评审人' }, statusCode: 403 }
  }
  const p = await reviewerProfile.get(profile_id)
  if (!p) return { body: { error: 'Profile 不存在' }, statusCode: 404 }
  const roleAssignments = normalizeRoleAssignments(jsonArr((p as any).role_assignments_json || (p as any).reviewers_json || '[]'))
  if (roleAssignments.length === 0) {
    return { body: { error: 'Profile 中没有角色分配' }, statusCode: 400 }
  }
  const reviewType = (rv as any).review_type || 'dcp'
  const profileType = (p as any).review_type || 'dcp'
  if (reviewType !== profileType) {
    return { body: { error: `Profile 类型（${profileType}）与评审单类型（${reviewType}）不匹配` }, statusCode: 400 }
  }
  const bindings = await qAll(projectBinding, (item: any) =>
    item.project_uuid === (rv as any).project_uuid &&
    (item.review_type || 'dcp') === reviewType &&
    item.profile_id === profile_id)
  if (bindings.length === 0) {
    return { body: { error: '只能应用当前项目已绑定的 Profile' }, statusCode: 403 }
  }
  const roleTemplates = await getRoleTemplatesForReview(rv)
  const snapshotReviewers = resolveAutoReviewers(roleAssignments, roleTemplates)
  let savedPayload: any[] = []
  try {
    savedPayload = await writeReviewersToEntities(rid, snapshotReviewers, roleTemplates, rv)
  } catch (e: any) {
    return { body: { error: e.message || String(e) }, statusCode: 400 }
  }
  await review.set(rid, cleanForSet({
    ...rv,
    reviewers_json: JSON.stringify(savedPayload),
    reviewer_profile_id: profile_id,
    reviewer_profile_name: (p as any).profile_name || '',
    reviewer_profile_snapshot_json: JSON.stringify({
      profile_id,
      profile_name: (p as any).profile_name || '',
      review_type: profileType,
      role_assignments: roleAssignments,
    }),
    reviewer_role_assignments_snapshot_json: JSON.stringify(roleAssignments),
    updated_at: Date.now(),
  }))
  await writeAudit(rid, operatorUuid, '应用Profile', rid,
    `从Profile「${(p as any).profile_name || profile_id}」应用评审人，共 ${savedPayload.length} 人`)
  Logger.info(`[DCP] Profile applied to review ${rid}: ${(p as any).profile_name}, ${savedPayload.length} reviewers`)
  return { body: { ok: true, applied_count: savedPayload.length, reviewers: savedPayload, profile_name: (p as any).profile_name } }
}

// ============================================================
// External API 安全出口
// plugin.yaml 仅引用以下包装器，业务函数不直接暴露给外部请求。
// ============================================================
export const apiGetDcpConfig = withAuthorization('identity', getDcpConfig)
export const apiSavePluginConfig = withAuthorization('admin', savePluginConfig)
export const apiCreateReview = withAuthorization('create', createReview)
export const apiGetReviewDetail = withAuthorization('review-read', getReviewDetail)
export const apiListReviewsByProject = withAuthorization('project-read', listReviewsByProject)
export const apiGetDcpReviews = withAuthorization('overview', getDcpReviews)
export const apiListMyReviews = withAuthorization('self', listMyReviews)
export const apiListTeamReviews = withAuthorization('overview', listTeamReviews)
export const apiStartReview = withAuthorization('review-creator', startReview)
export const apiRecallReview = withAuthorization('review-creator', recallReview)
export const apiUpdateReviewBasicInfo = withAuthorization('review-creator', updateReviewBasicInfo)
export const apiDeleteReview = withAuthorization('review-creator', deleteReview)
export const apiRecreateReview = withAuthorization('review-create-creator', recreateReview)
export const apiUpdateMaterialStatus = withAuthorization('review-contributor', updateMaterialStatus)
export const apiUploadMaterialFile = withAuthorization('review-contributor', uploadMaterialFile)
export const apiRemoveMaterialFile = withAuthorization('review-contributor', removeMaterialFile)
export const apiGetMaterialUploadUrl = withAuthorization('review-contributor', getMaterialUploadUrl)
export const apiGetMaterialDownloadUrl = withAuthorization('review-read', getMaterialDownloadUrl)
export const apiGetMaterialPreview = withAuthorization('review-read', getMaterialPreview)
export const apiGetAttachmentDownloadUrl = withAuthorization('review-read', getAttachmentDownloadUrl)
export const apiGetAttachmentPreview = withAuthorization('review-read', getAttachmentPreview)
export const apiUpdateIndicators = withAuthorization('review-contributor', updateIndicators)
export const apiUpdateReviewers = withAuthorization('review-creator', updateReviewers)
export const apiSubmitOpinion = withAuthorization('review-participant', submitOpinion)
export const apiLinkIssue = withAuthorization('review-contributor', linkIssue)
export const apiGetLinkedIssues = withAuthorization('review-read', getLinkedIssues)
export const apiCreateIssue = withAuthorization('review-contributor', createIssue)
export const apiListIssueTypes = withAuthorization('project-read', listIssueTypes)
export const apiGenerateResolution = withAuthorization('review-publisher', generateResolution)
export const apiPublishResolution = withAuthorization('review-publisher', publishResolution)
export const apiAddSupplement = withAuthorization('review-contributor', addSupplement)
export const apiGetAuditLog = withAuthorization('review-read', getAuditLog)
export const apiCheckChecklist = withAuthorization('review-participant', checkChecklist)
export const apiRemindReview = withAuthorization('review-creator', remindReview)
export const apiTransitionReview = withAuthorization('review-creator', transitionReview)
export const apiGetReviewState = withAuthorization('review-read', getReviewState)
export const apiGetReviewRounds = withAuthorization('review-read', getReviewRounds)
export const apiGetRemediationIssues = withAuthorization('review-read', getRemediationIssues)
export const apiRefreshRemediationStatus = withAuthorization('review-creator-or-publisher', refreshRemediationStatus)
export const apiSyncRemediationStatus = withAuthorization('review-creator-or-publisher', syncRemediationStatus)
export const apiConfirmRemediation = withAuthorization('review-publisher', confirmRemediation)
export const apiGetDcpStats = withAuthorization('overview', getDcpStats)
export const apiListReviewerProfiles = withAuthorization('admin', listReviewerProfiles)
export const apiCreateReviewerProfile = withAuthorization('admin', createReviewerProfile)
export const apiGetReviewerProfile = withAuthorization('admin', getReviewerProfile)
export const apiUpdateReviewerProfile = withAuthorization('admin', updateReviewerProfile)
export const apiDeleteReviewerProfile = withAuthorization('admin', deleteReviewerProfile)
export const apiListProjectBindings = withAuthorization('admin', listProjectBindings)
export const apiUpsertProjectBinding = withAuthorization('admin', upsertProjectBinding)
export const apiDeleteProjectBinding = withAuthorization('admin', deleteProjectBinding)
export const apiApplyProfileToReview = withAuthorization('review-create-creator', applyProfileToReview)
