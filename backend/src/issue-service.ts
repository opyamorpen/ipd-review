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
// - executeWorkflowViaOpenApi 的路径模板未在目标环境验证（OpenAPI v2 凭据需管理员配置）
// 两者均可通过 base_config 的 issue_transition_transport 覆盖，无需改代码。
// ============================================================
import { Logger } from '@ones-op/node-logger'
import { storage } from '@ones-op/sdk/node'
import { OPFetch } from '@ones-op/fetch'

const baseCfg = storage.entity('ipd_base_config')
const reviewStore = storage.entity('ipd_review')
const intentStore = storage.entity('ipd_transition_intent')
const auditStore = storage.entity('ipd_audit_log')

// 受保护的工作项属性名（与 plugin.yaml TaskEventHandler 的 field 默认配置保持一致）
export const PROTECTED_FIELD_NAMES = new Set(['会议时间', '评审轮次', '评审结论'])

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

// OpenAPI v2 工作流执行（需管理员在配置页提供组织凭据 token；路径模板可覆盖）
async function executeWorkflowViaOpenApi(
  teamUUID: string,
  issueUuid: string,
  statusUuid: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = (await getTransitionTransportConfig()) || {}
  const openapi = cfg.openapi || {}
  const token = openapi.token || (await readCfg('openapi_token'))
  if (!token) return { ok: false, error: 'openapi_token 未配置' }
  const host = openapi.host || (await readCfg('openapi_host'))
  if (!host) return { ok: false, error: 'openapi_host 未配置' }
  const pathTpl =
    openapi.path_template || '/openapi/v2/project/teams/{team}/issues/{issue}/workflow'
  const path = pathTpl.replace('{team}', teamUUID).replace('{issue}', issueUuid)
  try {
    const res = await withTimeout(
      OPFetch(`${host}${path}`, {
        method: openapi.method || 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        data: openapi.body_template
          ? JSON.parse(JSON.stringify(openapi.body_template).replace('{status_uuid}', statusUuid))
          : { status_uuid: statusUuid },
      }) as any,
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
