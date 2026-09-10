// ============================================================
// IPD评审 — 工作项详情页「评审过程」Tab
//
// 新架构：评审单主体 = 系统自定义工作项。本 Tab 嵌入原生工作项详情页，
// 通过 useProps('ones:issue:tab:new', 'Tab') 拿到 issueUUID（= 评审单主键），
// 展示评审过程数据（评审人意见/材料指标/Checklist/决议快照/状态轨迹/审计）。
// 标量字段（会议时间/轮次/结论）与状态由原生详情表单和工作流承载；
// 业务动作入口在详情页右上角「IPD评审操作」快捷按钮。
// ============================================================
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { ConfigProvider } from '@ones-design/core'
import { OPProvider } from '@ones-op/bridge'
import { useProps } from '@ones-op/sdk'
import { useTeamInfo } from '@ones-op/store'
import { getTeamUUID } from '../../../api'

const S: Record<string, React.CSSProperties> = {
  wrap: { padding: '12px 4px', fontSize: 13, color: '#1f2329' },
  header: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 },
  stateTag: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 12,
    background: '#e8f3ff',
    color: '#1b66ff',
    marginRight: 4,
  },
  card: {
    border: '1px solid #e5e6eb',
    borderRadius: 6,
    padding: '8px 12px',
    marginBottom: 10,
    background: '#fff',
  },
  cardTitle: { fontSize: 13, fontWeight: 600, margin: '2px 0 8px', color: '#1f2329' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: {
    textAlign: 'left',
    padding: '5px 8px',
    background: '#f7f8fa',
    borderBottom: '1px solid #e5e6eb',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '5px 8px',
    borderBottom: '1px solid #f2f3f5',
    verticalAlign: 'top',
    wordBreak: 'break-all',
  },
  hint: { fontSize: 12, color: '#86909c', marginTop: 8 },
  empty: { fontSize: 12, color: '#86909c', padding: '6px 0' },
}

const STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  ready: '就绪',
  reviewing: '评审中',
  awaiting_resolution: '待决议',
  resolution_published: '决议已发布',
  remediation_pending: '整改中',
  re_reviewing: '复审中',
  completed: '已完成',
  rejected: '已驳回',
  canceled: '已撤回',
  archived: '已归档',
}
const CONCLUSION_LABELS: Record<string, string> = {
  pass: '通过',
  conditional_pass: '有条件通过',
  reject: '驳回',
  fail: '不通过',
  rework: '返工',
}
const MAT_STATUS_LABELS: Record<string, string> = {
  pending: '待提交',
  submitted: '已提交',
  approved: '已通过',
  rejected: '已驳回',
  draft: '草稿',
}
const RISK_COLORS: Record<string, string> = { green: '#00b42a', yellow: '#ff7d00', red: '#f53f3f' }

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
  if (!res.ok) {
    const err: any = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const json = await res.json()
  return json.body || json.data || json
}

function fmtTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface TabContext {
  issueUUID?: string
  projectUUID?: string
  viewMode?: string
}

const ReviewProcessTab: React.FC = () => {
  const props = (useProps('ones:issue:tab:new', 'Tab') || {}) as TabContext
  const teamInfo = useTeamInfo() as any
  const issueUUID = props.issueUUID || ''
  if (issueUUID && !tu() && (teamInfo?.uuid || teamInfo?.teamUUID)) {
    _teamUUID = teamInfo.uuid || teamInfo.teamUUID
  }

  const [loading, setLoading] = useState(false)
  const [notReview, setNotReview] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!issueUUID || !tu()) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const d = await callApi<any>(`/ipd/review/${issueUUID}`)
        if (!cancelled) setDetail(d)
      } catch (e: any) {
        if (e?.status === 404 && !cancelled) setNotReview(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
      try {
        const res = await fetch(`/project/api/project/team/${tu()}/members?limit=500`, {
          credentials: 'include',
        } as any)
        const j = await res.json()
        const members = j?.body?.members || j?.members || []
        const m: Record<string, string> = {}
        for (const it of members) {
          if (it?.uuid) m[it.uuid] = it.name || it.uuid
        }
        if (!cancelled) setNameMap(m)
      } catch {
        /* 名称解析失败时显示 uuid */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [issueUUID])

  if (!issueUUID) {
    return (
      <div style={S.wrap}>
        <div style={S.empty}>未获取到工作项上下文，请刷新页面重试</div>
      </div>
    )
  }
  if (loading) {
    return (
      <div style={S.wrap}>
        <div style={S.empty}>加载评审过程数据…</div>
      </div>
    )
  }
  if (notReview || !detail) {
    return (
      <div style={S.wrap}>
        <div style={S.empty}>该工作项不是 IPD 评审单（未找到关联的评审数据）。</div>
      </div>
    )
  }

  const rv = detail.review || {}
  const state = rv.effective_state || rv.review_state || rv.status || 'draft'
  const reviewers: any[] = detail.reviewers || []
  const materials: any[] = detail.materials || []
  const indicators: any[] = detail.indicators || []
  const checklist: any[] = detail.checklist || []
  const resolution = detail.resolution || null
  const supplements: any[] = detail.supplements || []
  const history: any[] = detail.state_history || []

  return (
    <div style={S.wrap}>
      <div style={S.header}>
        <strong style={{ fontSize: 14 }}>{rv.review_number || rv.review_title || '评审单'}</strong>
        <span style={S.stateTag}>{STATE_LABELS[state] || state}</span>
        {rv.round_no > 1 && <span style={S.stateTag}>第 {rv.round_no} 轮</span>}
        <span style={{ fontSize: 12, color: '#86909c' }}>
          {rv.phase_name || rv.phase_code || ''} · {(rv.review_type || 'dcp').toUpperCase()} ·
          会议时间 {fmtTime(rv.meeting_time)}
          {rv.issue_number ? ` · 工作项 #${rv.issue_number}` : ''}
        </span>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>评审人与意见</div>
        {reviewers.length === 0 ? (
          <div style={S.empty}>暂未配置评审人</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>角色</th>
                <th style={S.th}>评审人</th>
                <th style={S.th}>结论</th>
                <th style={S.th}>风险</th>
                <th style={S.th}>意见摘要</th>
                <th style={S.th}>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {reviewers.map((r: any, i: number) => (
                <tr key={i}>
                  <td style={S.td}>
                    {r.role_name}
                    {r.is_publisher ? '（决议人）' : ''}
                  </td>
                  <td style={S.td}>
                    {r.reviewer_uuid ? nameMap[r.reviewer_uuid] || r.reviewer_uuid : '未指定'}
                  </td>
                  <td style={S.td}>
                    {r.conclusion ? CONCLUSION_LABELS[r.conclusion] || r.conclusion : '未提交'}
                  </td>
                  <td style={{ ...S.td, color: RISK_COLORS[r.risk_level] || undefined }}>
                    {r.risk_level === 'red' ? '红' : r.risk_level === 'yellow' ? '黄' : '绿'}
                  </td>
                  <td style={S.td}>{r.opinion_summary || '-'}</td>
                  <td style={S.td}>{r.submitted_at ? fmtTime(r.submitted_at) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>
          材料与指标{detail.can_edit_evidence === false ? '（已冻结，整改期可追加）' : ''}
        </div>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>材料</th>
              <th style={S.th}>必填</th>
              <th style={S.th}>状态</th>
              <th style={S.th}>文件</th>
            </tr>
          </thead>
          <tbody>
            {materials.length === 0 ? (
              <tr>
                <td style={S.td} colSpan={4}>
                  <span style={S.empty}>无材料模板</span>
                </td>
              </tr>
            ) : (
              materials.map((m: any, i: number) => (
                <tr key={i}>
                  <td style={S.td}>
                    {m.template?.material_name || m.material_name || m.template_id}
                  </td>
                  <td style={S.td}>{(m.template?.required ?? m.required) ? '是' : '否'}</td>
                  <td style={S.td}>
                    {MAT_STATUS_LABELS[m.submit_status] || m.submit_status || '-'}
                  </td>
                  <td style={S.td}>{m.file_name || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div style={{ height: 8 }} />
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>指标</th>
              <th style={S.th}>当前值</th>
              <th style={S.th}>阈值(黄/红)</th>
              <th style={S.th}>风险</th>
            </tr>
          </thead>
          <tbody>
            {indicators.length === 0 ? (
              <tr>
                <td style={S.td} colSpan={4}>
                  <span style={S.empty}>无指标模板</span>
                </td>
              </tr>
            ) : (
              indicators.map((ind: any, i: number) => (
                <tr
                  key={i}
                  style={{
                    background:
                      ind.risk_color === 'red'
                        ? '#fff1f0'
                        : ind.risk_color === 'yellow'
                          ? '#fff7e8'
                          : undefined,
                  }}
                >
                  <td style={S.td}>
                    {ind.template?.indicator_name || ind.indicator_name || ind.template_id}
                  </td>
                  <td style={S.td}>{ind.current_value ?? '-'}</td>
                  <td style={S.td}>
                    {ind.template?.yellow_threshold ?? ind.yellow_threshold ?? '-'} /{' '}
                    {ind.template?.red_threshold ?? ind.red_threshold ?? '-'}
                  </td>
                  <td style={{ ...S.td, color: RISK_COLORS[ind.risk_color] || undefined }}>
                    {ind.risk_color === 'red' ? '红' : ind.risk_color === 'yellow' ? '黄' : '绿'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {checklist.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Checklist</div>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>角色</th>
                <th style={S.th}>检查项</th>
                <th style={S.th}>状态</th>
              </tr>
            </thead>
            <tbody>
              {checklist.map((c: any, i: number) => (
                <tr key={i}>
                  <td style={S.td}>{c.role_name}</td>
                  <td style={S.td}>{c.item_text}</td>
                  <td
                    style={{
                      ...S.td,
                      color:
                        c.status === 'fail'
                          ? '#f53f3f'
                          : c.status === 'pass'
                            ? '#00b42a'
                            : undefined,
                    }}
                  >
                    {c.status === 'pass' ? '通过' : c.status === 'fail' ? '不通过' : '未检查'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={S.card}>
        <div style={S.cardTitle}>决议快照（不可覆盖）</div>
        {resolution ? (
          <div style={{ fontSize: 12, lineHeight: '22px' }}>
            <div>
              快照号：<strong>{resolution.snapshot_number}</strong> 结论：
              <strong
                style={{ color: resolution.final_conclusion === 'pass' ? '#00b42a' : '#ff7d00' }}
              >
                {CONCLUSION_LABELS[resolution.final_conclusion] || resolution.final_conclusion}
              </strong>
            </div>
            {resolution.condition_notes && <div>条件说明：{resolution.condition_notes}</div>}
            <div style={{ color: '#86909c' }}>
              发布：{resolution.published_by_name || resolution.published_by || '-'} ·{' '}
              {fmtTime(resolution.published_at)}
            </div>
          </div>
        ) : (
          <div style={S.empty}>当前轮次尚未发布决议</div>
        )}
        {supplements.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {supplements.map((sp: any, i: number) => (
              <div key={i} style={{ fontSize: 12, color: '#4e5969' }}>
                [{sp.note_type === 'rectification' ? '纠偏' : '补充'}] {sp.note_title} —{' '}
                {sp.note_content}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>状态轨迹</div>
        {history.length === 0 ? (
          <div style={S.empty}>暂无轨迹</div>
        ) : (
          <div style={{ fontSize: 12, lineHeight: '24px' }}>
            {history
              .slice()
              .reverse()
              .map((h: any, i: number) => (
                <div key={i}>
                  <span style={{ color: '#86909c' }}>{fmtTime(h.at)}</span>{' '}
                  <strong>
                    {STATE_LABELS[h.from_state] || h.from_state || '开始'} →{' '}
                    {STATE_LABELS[h.state] || h.state}
                  </strong>
                  {h.round_no > 1 ? `（第${h.round_no}轮）` : ''} {h.reason ? `· ${h.reason}` : ''}
                </div>
              ))}
          </div>
        )}
      </div>

      <div style={S.hint}>
        评审动作（发起评审 / 提交意见 / 发布决议 / 催办 / 复审 /
        撤回）请使用本详情页右上角的「IPD评审操作」快捷按钮；
        会议时间、评审轮次、评审结论等字段由评审流程自动维护，不支持直接编辑。
      </div>
    </div>
  )
}

const App: React.FC = () => (
  <ConfigProvider>
    <OPProvider>
      <ReviewProcessTab />
    </OPProvider>
  </ConfigProvider>
)

ReactDOM.render(<App />, document.getElementById('ones-mf-root'))
