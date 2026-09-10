// ============================================================
// IPD评审 — 工作项详情页快捷操作（LayoutCustomQuickAction + ones:global:modal）
//
// 在评审单工作项详情页右上角提供评审动作入口：
// 发起评审 / 提交评审意见 / 发布决议（含门禁 422 一键降级）/ 催办 / 开始复审 / 撤回 / 确认整改。
// 通过 useTaskInfo() 获取当前工作项 uuid（= 评审单主键），动作完成后 lifecycle.destroy() 销毁插槽。
// ============================================================
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { ConfigProvider, Modal } from '@ones-design/core'
import { lifecycle } from '@ones-op/bridge'
import { useTaskInfo, useTeamInfo } from '@ones-op/store'
import { getTeamUUID } from '../../api'

const CONCLUSION_LABELS: Record<string, string> = {
  pass: '通过',
  conditional_pass: '有条件通过',
  reject: '驳回',
  fail: '不通过',
  rework: '返工',
}
const STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  reviewing: '评审中',
  awaiting_resolution: '待决议',
  remediation_pending: '整改中',
  re_reviewing: '复审中',
  completed: '已完成',
  rejected: '已驳回',
}

let _teamUUID = ''
function tu(): string {
  if (!_teamUUID) {
    try {
      _teamUUID = getTeamUUID()
    } catch {
      _teamUUID = ''
    }
  }
  return _teamUUID
}

async function callApi<T = any>(endpoint: string, method = 'GET', body?: any): Promise<T> {
  const url = `/project/api/project/team/${tu()}${endpoint}`
  const opts: any = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Ones-Plugin-Id': 'ipdrev01' },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  let errBody: any = {}
  try {
    errBody = await res.clone().json()
  } catch {
    /* 非 JSON 错误体 */
  }
  const data = errBody?.body || errBody?.data || errBody
  if (!res.ok) {
    const err: any = new Error(data?.error || `HTTP ${res.status}`)
    err.status = res.status
    err.code = data?.code
    err.gateViolations = data?.gate_violations
    err.suggestDowngrade = data?.suggest_downgrade
    throw err
  }
  return json1(res)
}
async function json1(res: any): Promise<any> {
  try {
    const j = await res.json()
    return j.body || j.data || j
  } catch {
    return {}
  }
}

const btn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginBottom: 6,
  padding: '6px 10px',
  fontSize: 13,
  textAlign: 'left',
  background: '#f7f8fa',
  border: '1px solid #e5e6eb',
  borderRadius: 4,
  cursor: 'pointer',
}
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#4e5969',
  margin: '6px 0 2px',
}
const input: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  fontSize: 13,
  border: '1px solid #e5e6eb',
  borderRadius: 4,
  boxSizing: 'border-box',
}
const errBox: React.CSSProperties = {
  marginTop: 8,
  padding: 8,
  borderRadius: 4,
  background: '#fff1f0',
  border: '1px solid #ffccc7',
  color: '#cf1322',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}

const App: React.FC = () => {
  const taskInfo = useTaskInfo() as any
  const teamInfo = useTeamInfo() as any
  const taskUuid = String(taskInfo?.uuid || taskInfo?.taskUUID || '')
  if (taskUuid && !tu() && (teamInfo?.uuid || teamInfo?.teamUUID)) {
    _teamUUID = teamInfo.uuid || teamInfo.teamUUID
  }

  const [loading, setLoading] = useState(true)
  const [rv, setRv] = useState<any>(null)
  const [me, setMe] = useState('')
  const [action, setAction] = useState<
    'menu' | 'start' | 'opinion' | 'resolution' | 'recall' | 'remind'
  >('menu')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<any>(null)
  const [done, setDone] = useState('')

  // 表单状态
  const [conclusion, setConclusion] = useState('pass')
  const [riskLevel, setRiskLevel] = useState('medium')
  const [opinionText, setOpinionText] = useState('')
  const [notes, setNotes] = useState('')
  const [recallReason, setRecallReason] = useState('')

  useEffect(() => {
    if (!taskUuid) return
    let cancelled = false
    ;(async () => {
      try {
        const d = await callApi<any>(`/ipd/review/${taskUuid}`)
        if (!cancelled) setRv(d?.review || d)
      } catch {
        /* 非评审单工作项：显示提示 */
      }
      try {
        const res = await fetch('/project/api/project/users/me', { credentials: 'include' } as any)
        const j = await res.json()
        if (!cancelled) setMe(j?.body?.uuid || j?.user?.uuid || j?.uuid || '')
      } catch {
        /* 身份获取失败时按钮仍展示，后端会兜底校验 */
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [taskUuid])

  const state = rv ? rv.effective_state || rv.review_state || rv.status || 'draft' : ''
  const isCreator = !!me && me === rv?.creator_uuid

  async function run(fn: () => Promise<void>, okMsg: string) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setDone(okMsg)
      setTimeout(() => lifecycle.destroy(), 900)
    } catch (e: any) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const act = {
    start: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/start`, 'POST', {})
      }, '评审已发起，已通知评审人'),
    remind: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/remind`, 'POST', { target: 'reviewers' })
      }, '催办通知已发送'),
    reReview: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/transition`, 'POST', {
          target_state: 're_reviewing',
        })
      }, '已开始复审（新一轮）'),
    confirmRemediation: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/remediation/confirm`, 'POST', {})
      }, '整改已确认'),
    recall: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/recall`, 'POST', { reason: recallReason })
      }, '评审已撤回'),
    opinion: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/opinion`, 'POST', {
          conclusion,
          risk_level: riskLevel,
          opinion_summary: opinionText,
        })
      }, '评审意见已提交'),
    resolution: () =>
      run(async () => {
        await callApi(`/ipd/review/${taskUuid}/publish-resolution`, 'POST', {
          final_conclusion: conclusion,
          condition_notes: notes,
        })
      }, '决议已发布并写入不可覆盖快照'),
    downgrade: () =>
      run(async () => {
        setConclusion('conditional_pass')
        await callApi(`/ipd/review/${taskUuid}/publish-resolution`, 'POST', {
          final_conclusion: 'conditional_pass',
          condition_notes: notes || '门径校验拦截，降级为有条件通过',
        })
      }, '已按「有条件通过」发布决议'),
  }

  const body = () => {
    if (loading) return <div style={{ fontSize: 13, color: '#86909c' }}>加载评审数据…</div>
    if (done) return <div style={{ fontSize: 13, color: '#00b42a' }}>{done}</div>
    if (!rv) {
      return (
        <div style={{ fontSize: 13, color: '#86909c' }}>
          当前工作项不是 IPD 评审单，无可用评审操作。
        </div>
      )
    }

    if (action === 'start') {
      return (
        <div>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            发起评审：{rv.review_number}（{STATE_LABELS[state] || state}）
          </div>
          <div style={{ fontSize: 12, color: '#86909c' }}>
            将校验前置阶段、必投角色、必填材料与指标红线，并通知全部评审人。
          </div>
          {error && <div style={errBox}>{error.message || String(error)}</div>}
          <button
            style={{ ...btn, background: '#1b66ff', color: '#fff', border: 'none' }}
            disabled={busy}
            onClick={act.start}
          >
            {busy ? '发起中…' : '确认发起'}
          </button>
        </div>
      )
    }
    if (action === 'opinion') {
      return (
        <div>
          <span style={label}>评审结论</span>
          <select style={input} value={conclusion} onChange={(e) => setConclusion(e.target.value)}>
            {Object.entries(CONCLUSION_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <span style={label}>风险等级</span>
          <select style={input} value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
            <option value="green">绿（低风险）</option>
            <option value="yellow">黄（关注）</option>
            <option value="red">红（高风险）</option>
          </select>
          <span style={label}>意见摘要（非通过结论时必填）</span>
          <textarea
            style={{ ...input, height: 64 }}
            value={opinionText}
            onChange={(e) => setOpinionText(e.target.value)}
          />
          {error && <div style={errBox}>{error.message || String(error)}</div>}
          <button
            style={{ ...btn, background: '#1b66ff', color: '#fff', border: 'none' }}
            disabled={busy}
            onClick={act.opinion}
          >
            {busy ? '提交中…' : '提交评审意见'}
          </button>
        </div>
      )
    }
    if (action === 'resolution') {
      const gateBlocked = error?.status === 422 && error?.gateViolations
      return (
        <div>
          <span style={label}>决议结论</span>
          <select style={input} value={conclusion} onChange={(e) => setConclusion(e.target.value)}>
            {Object.entries(CONCLUSION_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <span style={label}>条件说明（有条件通过/返工必填）</span>
          <textarea
            style={{ ...input, height: 56 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {error && (
            <div style={errBox}>
              {error.message || String(error)}
              {gateBlocked && Array.isArray(error.gateViolations) && (
                <div>
                  {'\n'}门径校验：{error.gateViolations.join('；')}
                </div>
              )}
              {gateBlocked && error.suggestDowngrade === 'conditional_pass' && (
                <button style={{ ...btn, marginTop: 8 }} disabled={busy} onClick={act.downgrade}>
                  {busy ? '处理中…' : '一键降级为「有条件通过」'}
                </button>
              )}
            </div>
          )}
          <button
            style={{ ...btn, background: '#1b66ff', color: '#fff', border: 'none' }}
            disabled={busy}
            onClick={act.resolution}
          >
            {busy ? '发布中…' : '发布决议（不可覆盖）'}
          </button>
        </div>
      )
    }
    if (action === 'recall') {
      return (
        <div>
          <span style={label}>撤回原因</span>
          <textarea
            style={{ ...input, height: 56 }}
            value={recallReason}
            onChange={(e) => setRecallReason(e.target.value)}
          />
          {error && <div style={errBox}>{error.message || String(error)}</div>}
          <button
            style={{ ...btn, background: '#ff7d00', color: '#fff', border: 'none' }}
            disabled={busy}
            onClick={act.recall}
          >
            {busy ? '撤回中…' : '确认撤回'}
          </button>
        </div>
      )
    }

    // 菜单：按状态与身份展示可用动作
    return (
      <div>
        <div style={{ fontSize: 13, marginBottom: 8 }}>
          {rv.review_number} · {STATE_LABELS[state] || state}
          {rv.round_no > 1 ? ` · 第${rv.round_no}轮` : ''}
          {!isCreator && me && (
            <span style={{ color: '#86909c', fontSize: 12 }}>（非创建者，部分操作不可用）</span>
          )}
        </div>
        {state === 'draft' && isCreator && (
          <button style={btn} onClick={() => setAction('start')}>
            发起评审
          </button>
        )}
        {(state === 'reviewing' || state === 're_reviewing') && (
          <button style={btn} onClick={() => setAction('opinion')}>
            提交评审意见
          </button>
        )}
        {(state === 'reviewing' || state === 'awaiting_resolution' || state === 're_reviewing') && (
          <button style={btn} onClick={() => setAction('resolution')}>
            发布决议
          </button>
        )}
        {state === 'remediation_pending' && (
          <button style={btn} onClick={act.confirmRemediation}>
            确认整改完成
          </button>
        )}
        {state === 'remediation_pending' && isCreator && (
          <button style={btn} onClick={act.reReview}>
            开始复审（新一轮）
          </button>
        )}
        {(state === 'reviewing' || state === 'awaiting_resolution') && isCreator && (
          <button style={btn} onClick={() => setAction('recall')}>
            撤回评审
          </button>
        )}
        {(state === 'reviewing' || state === 'awaiting_resolution' || state === 're_reviewing') &&
          isCreator && (
            <button style={btn} onClick={act.remind}>
              催办未提交评审人
            </button>
          )}
        <div style={{ fontSize: 12, color: '#86909c', marginTop: 4 }}>
          详细过程数据见本详情页「评审过程」Tab。
        </div>
      </div>
    )
  }

  return (
    <Modal
      title="IPD评审操作"
      visible
      closable
      width={480}
      onCancel={() => lifecycle.destroy()}
      footer={null}
    >
      {body()}
    </Modal>
  )
}

ReactDOM.render(
  <ConfigProvider>
    <App />
  </ConfigProvider>,
  document.getElementById('ones-mf-root'),
)
