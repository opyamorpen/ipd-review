// ============================================================
// IPD评审 — 工作项服务层
//
// 新架构核心：评审单主体 = 系统自定义工作项。
// - 评审单主键(review_uuid)即工作项 uuid，插件存储按该 uuid 关联
// - 插件是状态机的唯一裁决方；工作项状态是"镜像"，由 pushStateMirror 尽力同步
// - task-event-handler.ts 守卫无意图的手动流转/字段修改，防止镜像跑到引擎前面
//
// ⚠️ 环境待验证点（PoC 清单）：
// - executeWorkflowViaInternal 的 GraphQL mutation 名称未在目标环境验证
// - OpenAPI 通道（FetchAsAdmin 插件身份自动鉴权）与路径模板未在目标环境验证
// 两者均可通过 base_config 的 issue_transition_transport 覆盖，无需改代码。
// ============================================================
import { Logger } from '@ones-op/node-logger'
import { storage } from '@ones-op/sdk/node'
import { FetchAsAdmin, OPFetch } from '@ones-op/fetch'

const baseCfg = storage.entity('ipd_base_config')
const reviewStore = storage.entity('ipd_review')
const intentStore = storage.entity('ipd_transition_intent')
const auditStore = storage.entity('ipd_audit_log')

// ---------------- 评审字段映射（评审数据 ↔ 工作项自定义字段） ----------------
// 一版默认映射：管理员在标品按《工作项映射指南》创建同名字段时零配置生效；
// 字段名不同则在配置页「工作项映射」中修改，存储 key = review_field_map。

export interface ReviewFieldBinding {
  name: string
  uuid?: string
}

export const DEFAULT_REVIEW_FIELD_MAP: Record<string, ReviewFieldBinding> = {
  meeting_time: { name: '会议时间' },
  round_no: { name: '评审轮次' },
  final_conclusion: { name: '评审结论' },
  phase_code: { name: '评审阶段' },
  review_type: { name: '评审类型' },
  review_number: { name: '评审编号' },
  condition_notes: { name: '决议条件说明' },
}

// 守卫冻结的三个必配字段；其余映射字段仅写回展示，不拦截手工修改
export const PROTECTED_FIELD_KEYS = ['meeting_time', 'round_no', 'final_conclusion']

function normalizeFieldBinding(v: any): ReviewFieldBinding | null {
  if (typeof v === 'string') {
    const name = v.trim()
    return name ? { name } : null
  }
  if (v && typeof v === 'object') {
    const name = String(v.name || '').trim()
    if (!name) return null
    const uuid = String(v.uuid || '').trim()
    return uuid ? { name, uuid } : { name }
  }
  return null
}

// 与默认合并，保证新增映射 key 在旧配置下也有默认值
export async function getReviewFieldMap(): Promise<Record<string, ReviewFieldBinding>> {
  const merged: Record<string, ReviewFieldBinding> = { ...DEFAULT_REVIEW_FIELD_MAP }
  const raw = await readCfg('review_field_map')
  if (!raw) return merged
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        const b = normalizeFieldBinding(v)
        if (b) merged[k] = b
      }
    }
  } catch {
    /* 配置损坏时回退默认 */
  }
  return merged
}

// 受保护的工作项属性名（守卫按 field_name / field_name_map.zh 名称匹配）
export async function getProtectedFieldNames(): Promise<Set<string>> {
  const map = await getReviewFieldMap()
  const names = new Set<string>()
  for (const key of PROTECTED_FIELD_KEYS) {
    const n = map[key]?.name
    if (n) names.add(n)
  }
  return names
}

// 意图有效期：插件发起流转→工作项落库 的窗口期
export const INTENT_TTL_MS = 60 * 1000

export function makeIssueUuid(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  return Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * 36)]).join('')
}

async function readCfg(key: string): Promise<string> {
  try {
    const row = await baseCfg.get(key)
    return String((row as any)?.value || '')
  } catch {
    return ''
  }
}

// 评审单工作项类型配置（管理员在配置页选择团队级类型后保存）
export async function getReviewIssueTypeConfig(): Promise<{ name: string; uuid: string }> {
  return {
    name: await readCfg('review_issue_type'),
    uuid: await readCfg('review_issue_type_uuid'),
  }
}

// REVIEW_STATES → 工作流状态 UUID 映射（管理员在配置页维护）
export async function getStatusMapConfig(): Promise<Record<string, string>> {
  const raw = await readCfg('review_status_map')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// 流转传输配置覆盖（openapi / internal graphql），管理员可在配置页覆盖默认行为
export async function getTransitionTransportConfig(): Promise<any> {
  const raw = await readCfg('issue_transition_transport')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------- OpenAPI 团队级列表（配置页映射选择器数据源） ----------------
// 官方接口：GET /openapi/v2/project/issueTypes|issueStatuses|issueFields?teamID=&limit=&cursor=
// 鉴权：FetchAsAdmin 以插件身份经平台内置 Oauth2AdminToken 能力自动获取管理员 token，
// 无需任何配置；个别环境内置能力不可用时，可在 transport 配置显式指定 openapi.host+token
// （逃生门，走手动 Bearer），地址默认取运行时 onesEnv.openapiServiceAddress。

async function getOpenApiOverrideCredential(): Promise<{ host: string; token: string }> {
  const cfg = (await getTransitionTransportConfig()) || {}
  const openapi = (cfg as any)?.openapi || {}
  return {
    host: String(openapi.host || '').replace(/\/+$/, ''),
    token: String(openapi.token || ''),
  }
}

async function openApiFetch(
  path: string,
  init: { method: string; data?: any },
  teamUUID: string,
): Promise<any> {
  const { host, token } = await getOpenApiOverrideCredential()
  if (host && token) {
    return OPFetch(`${host}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      ...(init.data !== undefined ? { data: init.data } : {}),
    }) as any
  }
  // 验证过的调用形态（BI 仪表盘项目同环境 PoC）：params.teamID 让 SDK 按 team 级换取
  // admin token；前提是 plugin.yaml 顶层声明 oauth.type=[admin] + 所需 scope
  return FetchAsAdmin(path, {
    method: init.method,
    params: { teamID: teamUUID },
    headers: { 'Content-Type': 'application/json' },
    ...(init.data !== undefined ? { data: init.data } : {}),
  }) as any
}

async function fetchOpenApiList(teamUUID: string, resource: string): Promise<any[]> {
  const out: any[] = []
  let cursor = ''
  // 防御上限 20 页 × 500 条，覆盖团队级类型/状态/字段总量
  // 注：插件沙箱无 URLSearchParams 全局，query 手工拼接；teamID 由 openApiFetch 的 params 携带
  for (let page = 0; page < 20; page++) {
    const qs = `limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res: any = await withTimeout(
      openApiFetch(`/openapi/v2/project/${resource}?${qs}`, { method: 'GET' }, teamUUID),
      8000,
    )
    // 兼容两种返回包装：OPFetch({body}) / FetchAsAdmin(axios {data})；
    // 官方响应形如 { data: { list: [...], pageInfo }, result }
    const raw = res?.body ?? res?.data ?? res
    const data = raw?.data || raw
    const list = Array.isArray(data?.list) ? data.list : []
    out.push(...list)
    const pi = data?.pageInfo
    if (!pi?.hasNextPage || !pi?.endCursor) break
    cursor = String(pi.endCursor)
  }
  return out
}

export interface MappingOptions {
  source: 'openapi'
  issueTypes: { id: string; name: string }[]
  issueStatuses: { id: string; name: string; category: string }[]
  issueFields: { id: string; name: string; typeLabel: string; options: string[] }[]
}

export async function loadMappingOptionsViaOpenApi(teamUUID: string): Promise<MappingOptions> {
  const [types, statuses, fields] = await Promise.all([
    fetchOpenApiList(teamUUID, 'issueTypes'),
    fetchOpenApiList(teamUUID, 'issueStatuses'),
    fetchOpenApiList(teamUUID, 'issueFields'),
  ])
  const optionLabel = (o: any): string => {
    const v = o?.value
    if (v == null) return String(o?.id || '')
    if (typeof v !== 'object') return String(v)
    return String(v.value ?? v.label ?? v.name ?? o?.id ?? '')
  }
  return {
    source: 'openapi',
    issueTypes: types
      .map((t: any) => ({ id: String(t?.id || ''), name: String(t?.name || '') }))
      .filter((t) => t.id && t.name),
    issueStatuses: statuses
      .map((s: any) => ({
        id: String(s?.id || ''),
        name: String(s?.name || ''),
        category: String(s?.category || ''),
      }))
      .filter((s) => s.id && s.name),
    issueFields: fields
      .map((f: any) => ({
        id: String(f?.id || ''),
        name: String(f?.name || ''),
        typeLabel: String(f?.typeLabel || ''),
        options: Array.isArray(f?.options) ? f.options.map(optionLabel).filter(Boolean) : [],
      }))
      .filter((f) => f.id && f.name),
  }
}

// 按工作项 uuid 查评审单：主键即工作项 uuid，直查优先，属性回退兜底
export async function findReviewByIssueUuid(taskUuid: string): Promise<any | null> {
  if (!taskUuid) return null
  try {
    const direct = await reviewStore.get(taskUuid)
    if (direct && (direct as any).review_uuid) return { _key: taskUuid, ...(direct as any) }
  } catch {
    /* key 不存在 */
  }
  try {
    const q = reviewStore.query().limit(200)
    const result = await q.getMany()
    if (result && Array.isArray(result.data)) {
      for (const d of result.data) {
        if (d.value?.issue_uuid === taskUuid) return { _key: d.key, ...d.value }
      }
    }
  } catch (e: any) {
    Logger.info(`[IPD] findReviewByIssueUuid fallback scan failed: ${e?.message || e}`)
  }
  return null
}

async function auditSvc(
  rvUuid: string,
  op: string,
  action: string,
  target: string,
  detail: string,
  result = 'success',
) {
  const k = `${rvUuid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  try {
    await auditStore.set(k, {
      review_uuid: rvUuid,
      timestamp: Date.now(),
      operator_uuid: op || '',
      action,
      target,
      detail,
      result,
    })
  } catch {
    /* 审计失败不阻塞业务 */
  }
}

// ---------------- 流转意图 ----------------
// 插件在驱动工作项变更（新建/流转/写受保护字段）之前先写意图；
// taskPreAction 校验到匹配意图才放行，避免插件被自己的守卫拦截。
// 每个工作项同一时刻只有一条意图（key = task_uuid），60 秒过期。

export async function claimTransitionIntent(
  taskUuid: string,
  targetState: string,
  actorUuid: string,
): Promise<void> {
  const nonce = Math.random().toString(36).slice(2, 10)
  await intentStore.set(taskUuid, {
    task_uuid: taskUuid,
    target_state: targetState,
    nonce,
    actor_uuid: actorUuid || '',
    created_at: Date.now(),
  })
}

export async function hasLiveIntent(taskUuid: string): Promise<boolean> {
  try {
    const row = await intentStore.get(taskUuid)
    if (!row) return false
    const createdAt = Number((row as any).created_at || 0)
    if (createdAt && Date.now() - createdAt > INTENT_TTL_MS) {
      await intentStore.delete(taskUuid)
      return false
    }
    return true
  } catch {
    return false
  }
}

export async function consumeTransitionIntent(taskUuid: string): Promise<void> {
  try {
    await intentStore.delete(taskUuid)
  } catch {
    /* 已不存在 */
  }
}

// ---------------- 评审单工作项创建 ----------------

export interface CreateReviewIssueOpts {
  teamUUID: string
  uuid: string
  project_uuid: string
  issue_type_uuid: string
  title: string
  assignee_uuid?: string
  // 初始字段值（review_field_map 的 key → 值），按映射写入工作项自定义字段
  initialFieldValues?: Record<string, any>
}

export interface CreateReviewIssueResult {
  ok: boolean
  uuid: string
  number: string
  error?: string
}

export async function createReviewIssue(
  opts: CreateReviewIssueOpts,
): Promise<CreateReviewIssueResult> {
  const { teamUUID, uuid, project_uuid, issue_type_uuid, title, assignee_uuid } = opts
  if (!issue_type_uuid) {
    return {
      ok: false,
      uuid: '',
      number: '',
      error: '未配置评审单工作项类型，请先在「IPD评审」模板配置中选择',
    }
  }
  // 按字段映射解析初始字段值（有 uuid 用 uuid，无则按名称走 OpenAPI 解析，失败审计跳过）
  let extraFieldValues: { field_uuid: string; value: any }[] = []
  if (opts.initialFieldValues && Object.keys(opts.initialFieldValues).length > 0) {
    const resolved = await resolveFieldValues(teamUUID, opts.initialFieldValues)
    extraFieldValues = resolved.fieldValues
    if (resolved.unresolved.length > 0) {
      await auditSvc(
        uuid,
        '',
        '创建字段未写入',
        resolved.unresolved.join(','),
        `以下映射字段未找到同名工作项自定义字段，初始值未写入（请检查「工作项映射」配置）: ${resolved.unresolved.join('、')}`,
        'denied',
      )
    }
  }
  const internalPaths = [
    `/project/api/project/team/${teamUUID}/tasks/add3`,
    `/project/api/project/team/${teamUUID}/tasks`,
  ]
  let res: any = null
  const errors: any[] = []
  for (const path of internalPaths) {
    try {
      const isAdd3 = path.endsWith('/add3')
      const body: any = isAdd3
        ? {
            tasks: [
              {
                uuid,
                project_uuid,
                issue_type_uuid,
                field_values: [
                  { field_uuid: 'field001', value: title },
                  { field_uuid: 'field006', value: project_uuid },
                  { field_uuid: 'field007', value: issue_type_uuid },
                  ...(assignee_uuid ? [{ field_uuid: 'field004', value: assignee_uuid }] : []),
                  ...extraFieldValues,
                ],
              },
            ],
          }
        : {
            assignee: assignee_uuid || '',
            title,
            project_uuid,
            issue_type_uuid,
            uuid,
          }
      res = (await OPFetch(path, {
        method: 'POST',
        teamUUID,
        headers: { 'Content-Type': 'application/json' },
        data: body,
      })) as any
      if (isAdd3 && res?.data?.tasks?.[0]?.uuid) {
        const t = res.data.tasks[0]
        res.data = { uuid: t.uuid, display_id: t.display_id, issue_number: t.display_id }
      }
      if (res?.data?.uuid || res?.data?.issue_uuid) break
    } catch (innerErr: any) {
      errors.push({
        path,
        message: innerErr?.message || '',
        errcode: innerErr?.response?.data?.errcode || innerErr?.data?.errcode,
      })
      Logger.error('[IPD] create review issue failed:', JSON.stringify(errors[errors.length - 1]))
    }
  }
  const issueData = res?.data || res || {}
  const issueUuid = issueData.uuid || issueData.issue_uuid || ''
  const issueNumber = issueData.display_id || issueData.issue_number || ''
  if (!issueUuid) {
    return {
      ok: false,
      uuid: '',
      number: '',
      error: `创建评审单工作项失败：${errors[0]?.errcode || errors[0]?.message || '未知错误'}（请确认项目已启用配置的评审单工作项类型）`,
    }
  }
  return { ok: true, uuid: issueUuid, number: issueNumber }
}

// ---------------- 评审单工作项删除（草稿删除时） ----------------

export async function attemptDeleteReviewIssue(
  teamUUID: string,
  taskUuid: string,
): Promise<{ ok: boolean; error?: string }> {
  const paths = [
    `/project/api/project/team/${teamUUID}/tasks/${taskUuid}`,
    `/project/api/project/team/${teamUUID}/task/${taskUuid}`,
  ]
  for (const path of paths) {
    try {
      ;(await OPFetch(path, { method: 'DELETE', teamUUID })) as any
      return { ok: true }
    } catch (e: any) {
      Logger.info(`[IPD] delete review issue via ${path} failed: ${e?.message || e}`)
    }
  }
  return { ok: false, error: '工作项删除接口调用失败（内部端点待环境验证），请手动删除后重试' }
}

// ---------------- 状态镜像推送 ----------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ])
}

// OpenAPI v2 工作流执行（FetchAsAdmin 插件身份鉴权；transport 配置可覆盖凭据/路径/方法/请求体）
async function executeWorkflowViaOpenApi(
  teamUUID: string,
  issueUuid: string,
  statusUuid: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = (await getTransitionTransportConfig()) || {}
  const openapi = cfg.openapi || {}
  const pathTpl =
    openapi.path_template || '/openapi/v2/project/teams/{team}/issues/{issue}/workflow'
  const path = pathTpl.replace('{team}', teamUUID).replace('{issue}', issueUuid)
  try {
    const res = await withTimeout(
      openApiFetch(
        path,
        {
          method: openapi.method || 'POST',
          data: openapi.body_template
            ? JSON.parse(JSON.stringify(openapi.body_template).replace('{status_uuid}', statusUuid))
            : { status_uuid: statusUuid },
        },
        teamUUID,
      ),
      8000,
    )
    const resAny = res as any
    if (resAny && (resAny.code === 200 || resAny.ok || resAny.data)) return { ok: true }
    return { ok: false, error: JSON.stringify(resAny).slice(0, 200) }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// 内部 GraphQL 流转（mutation 名称待环境验证，可通过 transport 配置覆盖 query 模板）
async function executeWorkflowViaInternal(
  teamUUID: string,
  issueUuid: string,
  statusUuid: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = (await getTransitionTransportConfig()) || {}
  const internal = cfg.internal || {}
  const query = internal.query_template
    ? internal.query_template
        .replace('{issue_uuid}', issueUuid)
        .replace('{status_uuid}', statusUuid)
    : `mutation { updateTask(uuid: "${issueUuid}", status_uuid: "${statusUuid}") { uuid } }`
  try {
    const res = await withTimeout(
      OPFetch(`/project/api/project/team/${teamUUID}/items/graphql?t=ipdIssueTransition`, {
        method: 'POST',
        teamUUID,
        headers: { 'Content-Type': 'application/json' },
        data: { query },
      }) as any,
      8000,
    )
    const body = (res as any)?.body ?? res
    if (
      (body as any)?.errors &&
      Array.isArray((body as any).errors) &&
      (body as any).errors.length > 0
    ) {
      return { ok: false, error: JSON.stringify((body as any).errors).slice(0, 200) }
    }
    if (res && !(body as any)?.errors) return { ok: true }
    return { ok: false, error: JSON.stringify(res).slice(0, 200) }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export interface PushMirrorOpts {
  teamUUID: string
  taskUuid: string
  targetState: string
  actorUuid?: string
}

export interface PushMirrorResult {
  synced: boolean
  mode: 'ok-internal' | 'ok-openapi' | 'unmapped' | 'no-type' | 'failed'
  error?: string
}

// 插件状态机变更后，把目标状态推送到工作项镜像。
// 绝不抛错：失败仅审计 + 日志，插件状态始终是权威值；镜像漂移由守卫阻止用户侧乱序。
export async function pushStateMirror(opts: PushMirrorOpts): Promise<PushMirrorResult> {
  const { teamUUID, taskUuid, targetState, actorUuid } = opts
  try {
    const statusMap = await getStatusMapConfig()
    const statusUuid = statusMap[targetState]
    if (!statusUuid) {
      await auditSvc(
        taskUuid,
        actorUuid || '',
        '状态镜像未同步',
        targetState,
        `状态「${targetState}」未映射工作流状态 UUID，请在模板配置中补全映射`,
      )
      return { synced: false, mode: 'unmapped' }
    }
    // 写意图 → 尝试传输 → 无论成败清理意图（成功时 preAction 已消费）
    await claimTransitionIntent(taskUuid, targetState, actorUuid || '')
    let internalRes: { ok: boolean; error?: string } | null = null
    let openapiRes: { ok: boolean; error?: string } | null = null
    openapiRes = await executeWorkflowViaOpenApi(teamUUID, taskUuid, statusUuid)
    if (!openapiRes.ok) {
      internalRes = await executeWorkflowViaInternal(teamUUID, taskUuid, statusUuid)
    }
    const ok = openapiRes.ok || (internalRes?.ok ?? false)
    await consumeTransitionIntent(taskUuid)
    if (ok) {
      const mode = openapiRes.ok ? 'ok-openapi' : 'ok-internal'
      await auditSvc(
        taskUuid,
        actorUuid || '',
        '状态镜像同步',
        targetState,
        `工作项状态已同步至「${targetState}」（${mode}）`,
      )
      return { synced: true, mode }
    }
    const errDetail = `openapi: ${openapiRes.error}; internal: ${internalRes?.error}`
    await auditSvc(
      taskUuid,
      actorUuid || '',
      '状态镜像失败',
      targetState,
      `工作项状态同步「${targetState}」失败：${errDetail.slice(0, 300)}`,
      'denied',
    )
    Logger.error(`[IPD] state mirror push failed for ${taskUuid} -> ${targetState}: ${errDetail}`)
    return { synced: false, mode: 'failed', error: errDetail }
  } catch (e: any) {
    await consumeTransitionIntent(taskUuid)
    Logger.error(`[IPD] state mirror push error for ${taskUuid}: ${e?.message || e}`)
    return { synced: false, mode: 'failed', error: e?.message || String(e) }
  }
}

// ---------------- 字段镜像推送（评审数据 → 工作项自定义字段） ----------------

// 把 {映射key: 值} 解析为 add3/update3 的 field_values：
// 绑定里有 uuid 直接用；缺 uuid 时按名称走 OpenAPI issueFields 列表精确匹配（需凭据），
// 仍匹配不到的字段进入 unresolved（调用方审计提示，不阻塞业务）。
async function resolveFieldValues(
  teamUUID: string,
  values: Record<string, any>,
): Promise<{ fieldValues: { field_uuid: string; value: any }[]; unresolved: string[] }> {
  const map = await getReviewFieldMap()
  const fieldValues: { field_uuid: string; value: any }[] = []
  const unresolved: string[] = []
  const needLookup: { name: string; value: any }[] = []
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue
    const binding = map[key]
    if (!binding) continue
    if (binding.uuid) {
      fieldValues.push({ field_uuid: binding.uuid, value })
    } else {
      needLookup.push({ name: binding.name, value })
    }
  }
  if (needLookup.length > 0) {
    try {
      const fields = await fetchOpenApiList(teamUUID, 'issueFields')
      const byName = new Map<string, string>()
      for (const f of fields) {
        const id = String(f?.id || '')
        const name = String(f?.name || '')
        if (id && name && !byName.has(name)) byName.set(name, id)
      }
      for (const item of needLookup) {
        const uuid = byName.get(item.name)
        if (uuid) fieldValues.push({ field_uuid: uuid, value: item.value })
        else unresolved.push(item.name)
      }
    } catch {
      for (const item of needLookup) unresolved.push(item.name)
    }
  }
  return { fieldValues, unresolved }
}

// 内部 tasks/update3 更新工作项字段（请求形态与 add3 同构，端点待环境验证；
// 可用 base_config.issue_transition_transport.field_update.internal_path 覆盖）
async function updateIssueFieldsViaInternal(
  teamUUID: string,
  taskUuid: string,
  fieldValues: { field_uuid: string; value: any }[],
): Promise<{ ok: boolean; error?: string }> {
  const cfg = (await getTransitionTransportConfig()) || {}
  const path =
    (cfg as any)?.field_update?.internal_path ||
    `/project/api/project/team/${teamUUID}/tasks/update3`
  try {
    const res: any = await withTimeout(
      OPFetch(path, {
        method: 'POST',
        teamUUID,
        headers: { 'Content-Type': 'application/json' },
        data: { tasks: [{ uuid: taskUuid, field_values: fieldValues }] },
      }) as any,
      8000,
    )
    const body = (res as any)?.body ?? res
    if (body && (body.errcode || body.error)) {
      return { ok: false, error: JSON.stringify(body).slice(0, 200) }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export interface PushFieldMirrorOpts {
  teamUUID: string
  taskUuid: string
  actorUuid?: string
  // review_field_map 的 key → 新值（空值自动跳过）
  values: Record<string, any>
  // 标题（工作项原生字段 field001）一并更新
  title?: string
}

export interface PushFieldMirrorResult {
  synced: boolean
  skipped?: string[]
  error?: string
}

// 评审数据变更后写回工作项（尽力模式：失败仅审计，不阻塞业务）。
// 写前登记流转意图，避免被自身 update 守卫拦截（与状态镜像同款机制）。
export async function pushFieldMirror(opts: PushFieldMirrorOpts): Promise<PushFieldMirrorResult> {
  const { teamUUID, taskUuid, actorUuid, values, title } = opts
  try {
    const { fieldValues, unresolved } = await resolveFieldValues(teamUUID, values)
    if (title) fieldValues.unshift({ field_uuid: 'field001', value: title })
    if (unresolved.length > 0) {
      await auditSvc(
        taskUuid,
        actorUuid || '',
        '字段镜像未同步',
        unresolved.join(','),
        `以下字段名未匹配到工作项自定义字段，请检查「工作项映射」配置: ${unresolved.join('、')}`,
        'denied',
      )
    }
    if (fieldValues.length === 0) return { synced: false, skipped: unresolved }
    await claimTransitionIntent(taskUuid, 'field_update', actorUuid || '')
    const res = await updateIssueFieldsViaInternal(teamUUID, taskUuid, fieldValues)
    await consumeTransitionIntent(taskUuid)
    const touched = Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k]) => k)
    if (res.ok) {
      await auditSvc(
        taskUuid,
        actorUuid || '',
        '字段镜像同步',
        touched.join(','),
        `工作项字段已更新: ${touched.join('、') || '标题'}`,
      )
      return { synced: true }
    }
    await auditSvc(
      taskUuid,
      actorUuid || '',
      '字段镜像失败',
      touched.join(','),
      `工作项字段更新失败: ${res.error || ''}`.slice(0, 300),
      'denied',
    )
    Logger.error(`[IPD] field mirror push failed for ${taskUuid}: ${res.error}`)
    return { synced: false, error: res.error }
  } catch (e: any) {
    await consumeTransitionIntent(taskUuid)
    Logger.error(`[IPD] field mirror push error for ${taskUuid}: ${e?.message || e}`)
    return { synced: false, error: e?.message || String(e) }
  }
}
