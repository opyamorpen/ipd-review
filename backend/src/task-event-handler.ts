// ============================================================
// IPD评审 — 工作项流转守卫（TaskEventHandler 能力）
//
// 新架构的"反向守门"：插件是评审单状态机的唯一裁决方，
// 本文件拦截所有绕过插件、直接作用在评审单工作项上的操作：
//   1. add    ：评审单类型的工作项必须由插件发起（createReview 带 add 意图）
//   2. transit：无意图的手动/批量/自动化流转 → 拒绝，引导走评审操作
//   3. update ：冻结语义下修改受保护字段（会议时间/评审轮次/评审结论）→ 拒绝
//   4. change_issue_type：评审单不允许变更工作项类型
//
// 意图机制见 issue-service.ts：插件自身驱动变更前先写 ipd_transition_intent，
// 本文件校验到匹配意图即放行并消费（60s TTL，单次有效）。
//
// 注意（官方契约边界）：
// - TaskEventHandler 不覆盖：评论、附件、计算属性、后置动作触发的变动、
//   非正常流程修改状态。这些路径的漂移由事件(onIssueUpdated)事后审计兜底。
// - transit/publish_version 动作中插件不得改写状态，本文件只做拒绝/放行。
// ============================================================
import { Logger } from '@ones-op/node-logger'
import {
  findReviewByIssueUuid,
  hasLiveIntent,
  consumeTransitionIntent,
  getReviewIssueTypeConfig,
  PROTECTED_FIELD_NAMES,
} from './issue-service'

function preActionResponse(
  isFollow: boolean,
  isReject: boolean,
  rejectReason: string,
  events: any,
) {
  return {
    statusCode: 200,
    body: {
      code: 200,
      body: {
        is_follow: isFollow,
        is_reject: isReject,
        reject_reason: rejectReason,
        task_events: events,
        other_data: '',
      },
    },
  }
}

export async function taskPreAction(request: any): Promise<any> {
  const body = (request?.body || {}) as any
  const events = body.task_events
  if (!Array.isArray(events) || events.length === 0) {
    return preActionResponse(false, false, '', [])
  }

  let isReject = false
  let rejectReason = ''
  let follow = false

  for (const ev of events) {
    const action = String(ev?.action || '')
    const taskUuid = String(ev?.task_uuid || '')
    if (!taskUuid) continue

    if (action === 'add') {
      // 评审单类型的工作项只允许插件创建（createReview 先写 add 意图）
      try {
        const typeCfg = await getReviewIssueTypeConfig()
        const scopeName = String(ev?.issue_type_scope_name || '')
        const scopeUuid = String(ev?.issue_type_scope_uuid || '')
        const matchesReviewType =
          (typeCfg.uuid && scopeUuid && typeCfg.uuid === scopeUuid) ||
          (typeCfg.name && scopeName && typeCfg.name === scopeName)
        if (matchesReviewType) {
          if (await hasLiveIntent(taskUuid)) {
            follow = true
            await consumeTransitionIntent(taskUuid)
          } else {
            isReject = true
            rejectReason = 'IPD评审单必须通过「IPD评审」工作台发起，不允许手动新建该类型工作项'
          }
        }
      } catch (e: any) {
        Logger.error(`[IPD][GUARD] add-guard error for ${taskUuid}: ${e?.message || e}`)
      }
      continue
    }

    if (action === 'change_issue_type') {
      const rv = await findReviewByIssueUuid(taskUuid)
      if (rv) {
        follow = true
        isReject = true
        rejectReason = '不允许变更IPD评审单的工作项类型'
      }
      continue
    }

    if (action === 'transit') {
      const rv = await findReviewByIssueUuid(taskUuid)
      if (!rv) continue
      follow = true
      if (await hasLiveIntent(taskUuid)) {
        await consumeTransitionIntent(taskUuid)
      } else {
        isReject = true
        rejectReason =
          'IPD评审单的状态由评审流程驱动，请使用工作项详情页的「IPD评审操作」快捷按钮，或「评审过程」Tab 中的评审动作完成流转'
      }
      continue
    }

    if (action === 'update') {
      const rv = await findReviewByIssueUuid(taskUuid)
      if (!rv) continue
      follow = true
      const fields = Array.isArray(ev?.task_fields) ? ev.task_fields : []
      const touchedProtected = fields.some(
        (f: any) =>
          PROTECTED_FIELD_NAMES.has(String(f?.field_name || '')) ||
          PROTECTED_FIELD_NAMES.has(String(f?.field_name_map?.zh || '')),
      )
      if (touchedProtected) {
        if (await hasLiveIntent(taskUuid)) {
          await consumeTransitionIntent(taskUuid)
        } else {
          isReject = true
          rejectReason =
            '「会议时间 / 评审轮次 / 评审结论」由IPD评审流程维护，请在工作项详情页「评审过程」Tab 中操作'
        }
      }
      // 标题等其他字段允许原生编辑，由 onIssueUpdated 事件同步回插件存储
      continue
    }
  }

  if (isReject) {
    Logger.info(`[IPD][GUARD] rejected task change: ${rejectReason}`)
  }
  return preActionResponse(follow || isReject, isReject, rejectReason, events)
}

export async function taskActionDone(request: any): Promise<any> {
  // 后置通知：仅记录日志，业务一致性由插件状态机与事件同步保证
  try {
    const body = (request?.body || {}) as any
    const events = Array.isArray(body.task_events) ? body.task_events : []
    for (const ev of events) {
      Logger.info(`[IPD][GUARD] action done: task=${ev?.task_uuid} action=${ev?.action}`)
    }
  } catch {
    /* 后置处理不允许抛错 */
  }
  return {
    statusCode: 200,
    body: { code: 200, body: {} },
  }
}
