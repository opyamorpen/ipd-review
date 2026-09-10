import React, { useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { apiGet, DcpApiError, getTeamUUID } from '../../api'
import { ReviewDetail } from '../dcp-review-tab'
import * as reviewApi from '../dcp-review-tab/api'

// ============================================================
// 前端兜底：浏览器侧补查项目名称（保留原有逻辑）
// ============================================================
function isProjectNameUnresolved(review: any): boolean {
  const name = review.project_name
  const identifier = review.project_identifier || review.project_uuid
  return !name || name === identifier || name === review.project_uuid
}

async function exchangeProject(teamUUID: string, projectKey: string): Promise<{ identifier: string; uuid: string } | null> {
  const res = await fetch(
    `/project/api/ones-project/team/${teamUUID}/projects/exchange/${projectKey}`,
    { credentials: 'include' }
  )
  if (!res.ok) return null
  const json = await res.json()
  const data = json?.data || json || {}
  return { identifier: data.identifier || projectKey, uuid: data.project_uuid || '' }
}

async function fetchProjectByStamp(teamUUID: string, realUUID: string): Promise<any> {
  if (!realUUID) return null
  const res = await fetch(
    `/project/api/project/team/${teamUUID}/project/${realUUID}/stamps/data?t=project`,
    { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 0 }) }
  )
  if (!res.ok) return null
  const json = await res.json()
  const data = json?.data || json || {}
  return data?.project?.projects?.[0] || null
}

async function hydrateProjectNames(teamUUID: string, reviews: any[]): Promise<any[]> {
  const unresolvedKeys = [...new Set(
    reviews.filter(isProjectNameUnresolved).map((r: any) => r.project_identifier || r.project_uuid).filter(Boolean)
  )]
  if (!unresolvedKeys.length) return reviews
  const projectMap: Record<string, any> = {}
  for (const key of unresolvedKeys) {
    try {
      const exchanged = await exchangeProject(teamUUID, key)
      const project = exchanged?.uuid ? await fetchProjectByStamp(teamUUID, exchanged.uuid) : null
      if (project?.name) {
        projectMap[key] = { identifier: project.identifier || exchanged?.identifier || key, uuid: project.uuid || exchanged?.uuid || '', name: project.name }
      }
    } catch { /* next */ }
  }
  if (!Object.keys(projectMap).length) return reviews
  return reviews.map(review => {
    const key = review.project_identifier || review.project_uuid
    const project = projectMap[key]
    if (!project) return review
    return { ...review,
      project_identifier: project.identifier || review.project_identifier || review.project_uuid,
      project_real_uuid: project.uuid || review.project_real_uuid || '',
      project_name: project.name || review.project_name || review.project_uuid,
    }
  })
}

// ============================================================
// 常量
// ============================================================
const STATUS_LABELS: Record<string, string> = { draft: '草稿', reviewing: '评审中', completed: '已完成', rejected: '已否决' }
const STATUS_COLORS: Record<string, string> = { draft: '#999', reviewing: '#1677ff', completed: '#52c41a', rejected: '#ff4d4f' }
const CONCLUSION_LABELS: Record<string, string> = { pass: '✅ 通过', conditional_pass: '⚠️ 有条件通过', fail: '❌ 不通过', reject: '🔄 驳回', rework: '🔧 返工' }

const S: Record<string, any> = {
  container: { padding: 20, fontFamily: 'sans-serif', fontSize: 13, color: '#333' },
  statsBar: { display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' as any },
  statCard: { flex: '1 1 120px', padding: 16, background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8', textAlign: 'center' as any, cursor: 'pointer' as any },
  statNum: { fontSize: 28, fontWeight: 700 },
  statLabel: { fontSize: 12, color: '#999', marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: 600, margin: '24px 0 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } as React.CSSProperties,
  section: { background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8', padding: 20, marginBottom: 20 },
  table: { width: '100%', borderCollapse: 'collapse' as any, fontSize: 13 },
  th: { padding: '8px 12px', textAlign: 'left' as any, background: '#fafafa', borderBottom: '1px solid #e8e8e8', cursor: 'pointer' as any },
  td: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0' },
  btn: { padding: '4px 12px', border: '1px solid #d9d9d9', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 12 },
  btnActive: { padding: '4px 12px', border: '1px solid #1677ff', borderRadius: 4, background: '#e6f4ff', color: '#1677ff', cursor: 'pointer', fontSize: 12 },
  backBtn: { padding: '6px 16px', border: '1px solid #d9d9d9', borderRadius: 4, background: '#fff', color: '#333', cursor: 'pointer', fontSize: 13, marginBottom: 16 },
  statusTag: (c: string): React.CSSProperties => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, background: `${c}1a`, color: c, fontWeight: 600 }),
  // 简易柱状图
  barRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  barLabel: { width: 80, textAlign: 'right' as any, fontSize: 12, color: '#595959', flexShrink: 0 },
  barTrack: { flex: 1, height: 20, background: '#f5f5f5', borderRadius: 4, position: 'relative' as any },
  barFill: (color: string, pct: number): React.CSSProperties => ({ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.3s' }),
  barNum: { width: 40, fontSize: 12, color: '#595959', flexShrink: 0 },
  // 饼图（简易 CSS 圆锥）
  pieContainer: { display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' as any },
  pieLegend: { display: 'flex', flexDirection: 'column' as any, gap: 4 },
  pieLegendItem: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' as any },
  pieDot: (color: string): React.CSSProperties => ({ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }),
}

// ============================================================
// 时间筛选器
// ============================================================
function TimeFilter({ startDate, endDate, onFilter }: {
  startDate: string; endDate: string; onFilter: (s: string, e: string) => void
}) {
  const [customStart, setCustomStart] = useState(startDate)
  const [customEnd, setCustomEnd] = useState(endDate)

  function fmt(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function getRange(preset: string): [string, string] {
    const now = new Date()
    const end = fmt(now)
    let start = ''
    if (preset === 'week') { const d = new Date(); d.setDate(d.getDate() - 7); start = fmt(d) }
    else if (preset === 'month') { const d = new Date(); d.setMonth(d.getMonth(), 1); start = fmt(d) }
    else if (preset === 'quarter') { const d = new Date(); d.setMonth(d.getMonth() - 3); start = fmt(d) }
    else if (preset === 'year') { start = `${now.getFullYear()}-01-01` }
    else if (preset === 'all') { start = '' }
    return [start, end]
  }
  function applyPreset(preset: string) {
    const [s, e] = getRange(preset)
    setCustomStart(s); setCustomEnd(e)
    onFilter(s, e)
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
      <button style={S.btn} onClick={() => applyPreset('week')}>本周</button>
      <button style={S.btn} onClick={() => applyPreset('month')}>本月</button>
      <button style={S.btn} onClick={() => applyPreset('quarter')}>本季度</button>
      <button style={S.btn} onClick={() => applyPreset('year')}>本年</button>
      <button style={S.btn} onClick={() => applyPreset('all')}>全部</button>
      <span style={{ margin: '0 4px', color: '#ccc' }}>|</span>
      <input type="date" value={customStart} onChange={(e: any) => setCustomStart(e.target.value)}
        style={{ padding: '4px 8px', border: '1px solid #d9d9d9', borderRadius: 4, fontSize: 12 }} />
      <span style={{ color: '#999' }}>~</span>
      <input type="date" value={customEnd} onChange={(e: any) => setCustomEnd(e.target.value)}
        style={{ padding: '4px 8px', border: '1px solid #d9d9d9', borderRadius: 4, fontSize: 12 }} />
      <button style={S.btnActive} onClick={() => onFilter(customStart, customEnd)}>查询</button>
    </div>
  )
}

// ============================================================
// 简易柱状图
// ============================================================
function BarChart({ data, color, onBarClick }: {
  data: { label: string; value: number; filter?: any }[]
  color: string
  onBarClick?: (filter: any) => void
}) {
  const max = Math.max(...data.map((d: any) => d.value), 1)
  return (
    <div>
      {data.map((d: any, i: number) => (
        <div key={i} style={S.barRow}>
          <div style={S.barLabel}>{d.label}</div>
          <div style={S.barTrack} onClick={() => onBarClick?.(d.filter)}>
            <div style={{ ...S.barFill(color, (d.value / max) * 100), cursor: onBarClick ? 'pointer' : 'default' }} />
          </div>
          <div style={S.barNum}>{d.value}</div>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// 简易 SVG 折线图（周趋势）
// ============================================================
function LineChart({ data, color }: {
  data: { week: string; count: number }[]
  color: string
}) {
  if (!data.length) return <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>暂无数据</div>
  const width = 800, height = 180
  const pad = { top: 20, right: 20, bottom: 30, left: 40 }
  const cw = width - pad.left - pad.right
  const ch = height - pad.top - pad.bottom
  const max = Math.max(...data.map((d: any) => d.count), 1)
  const stepX = data.length > 1 ? cw / (data.length - 1) : 0
  const points = data.map((d: any, i: number) => ({
    x: pad.left + i * stepX,
    y: pad.top + ch - (d.count / max) * ch,
    ...d,
  }))
  const pathD = points.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const labelStep = Math.max(1, Math.ceil(data.length / 8))
  const yTicks = [0, Math.ceil(max / 2), max]
  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {yTicks.map((v: number, i: number) => {
          const y = pad.top + ch - (v / max) * ch
          return (
            <g key={i}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="#f0f0f0" strokeDasharray="2,2" />
              <text x={pad.left - 6} y={y + 4} textAnchor="end" fontSize="11" fill="#999">{v}</text>
            </g>
          )
        })}
        {points.map((p: any, i: number) => {
          if (i % labelStep !== 0 && i !== points.length - 1) return null
          return <text key={i} x={p.x} y={height - 8} textAnchor="middle" fontSize="10" fill="#999">{p.week}</text>
        })}
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" />
        {points.map((p: any, i: number) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="4" fill={color} />
            <title>{p.week}: {p.count}</title>
            {p.count > 0 && <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize="11" fill={color} fontWeight="600">{p.count}</text>}
          </g>
        ))}
      </svg>
    </div>
  )
}
// ============================================================
function PieChart({ data, onClick }: {
  data: { label: string; value: number; color: string; filter?: any }[]
  onClick?: (filter: any) => void
}) {
  const total = data.reduce((s: number, d: any) => s + d.value, 0) || 1
  let acc = 0
  const segments = data.map((d: any) => {
    const pct = (d.value / total) * 100
    const start = acc
    acc += pct
    return { ...d, start, pct }
  })

  // 构建 conic-gradient
  const stops: string[] = []
  for (const seg of segments) {
    if (seg.pct === 0) continue
    const endDeg = (seg.start + seg.pct) * 3.6
    if (seg.start === 0) {
      stops.push(`${seg.color} 0 ${endDeg.toFixed(1)}deg`)
    } else {
      const startDeg = seg.start * 3.6
      stops.push(`${seg.color} ${startDeg.toFixed(1)}deg ${endDeg.toFixed(1)}deg`)
    }
  }
  const gradient = stops.length > 0 ? `conic-gradient(${stops.join(', ')})` : '#f5f5f5'

  return (
    <div style={S.pieContainer}>
      <div style={{
        width: 120, height: 120, borderRadius: '50%', background: gradient,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700 }}>
          {total}
        </div>
      </div>
      <div style={S.pieLegend}>
        {data.map((d: any, i: number) => (
          <div key={i} style={S.pieLegendItem} onClick={() => onClick?.(d.filter)}>
            <div style={S.pieDot(d.color)} />
            <span>{d.label}</span>
            <span style={{ color: '#999' }}>{d.value} ({Math.round((d.value / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// 穿透评审列表
// ============================================================
function DrillDownList({ reviews, onOpenDetail, onBack, title }: {
  reviews: any[]; onOpenDetail: (rid: string) => void; onBack: () => void; title: string
}) {
  const [sortKey, setSortKey] = useState('created_at')
  const [sortDesc, setSortDesc] = useState(true)

  function sortBy(key: string) {
    if (sortKey === key) { setSortDesc(!sortDesc) } else { setSortKey(key); setSortDesc(true) }
  }

  const sorted = [...reviews].sort((a: any, b: any) => {
    let va = a[sortKey], vb = b[sortKey]
    if (typeof va === 'number' && typeof vb === 'number') return sortDesc ? vb - va : va - vb
    return sortDesc ? String(vb).localeCompare(String(va)) : String(va).localeCompare(String(vb))
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button style={S.backBtn} onClick={onBack}>← 返回报表</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}（{reviews.length} 条）</span>
      </div>
      {sorted.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#999', background: '#fafafa', borderRadius: 8 }}>无评审记录</div>
      ) : (
        <table style={S.table}><thead><tr>
          <th style={S.th} onClick={() => sortBy('review_number')}>编号 {sortKey === 'review_number' ? (sortDesc ? '↓' : '↑') : ''}</th>
          <th style={S.th} onClick={() => sortBy('phase_code')}>阶段 {sortKey === 'phase_code' ? (sortDesc ? '↓' : '↑') : ''}</th>
          <th style={S.th} onClick={() => sortBy('review_title')}>标题 {sortKey === 'review_title' ? (sortDesc ? '↓' : '↑') : ''}</th>
          <th style={{ ...S.th, width: 80, textAlign: 'center' }}>状态</th>
          <th style={{ ...S.th, width: 130 }} onClick={() => sortBy('created_at')}>创建时间 {sortKey === 'created_at' ? (sortDesc ? '↓' : '↑') : ''}</th>
        </tr></thead><tbody>
          {sorted.map((r: any, i: number) => {
            const sc = STATUS_COLORS[r.status] || '#999'
            const sl = STATUS_LABELS[r.status] || r.status
            return (
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }} onClick={() => onOpenDetail(r.review_uuid)}>
                <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, color: '#1677ff', fontWeight: 600 }}>{r.review_number || '-'}</td>
                <td style={{ ...S.td, fontWeight: 600 }}>{r.phase_code}</td>
                <td style={{ ...S.td, color: '#1677ff', textDecoration: 'underline' }}>{r.review_title || r.review_uuid?.substring(0, 12)}</td>
                <td style={{ ...S.td, textAlign: 'center' }}><span style={S.statusTag(sc)}>{sl}</span></td>
                <td style={{ ...S.td, fontSize: 12, color: '#999' }}>{r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '-'}</td>
              </tr>
            )
          })}
        </tbody></table>
      )}
    </div>
  )
}

// ============================================================
// 主组件
// ============================================================
const App: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<any>(null)
  const [allReviews, setAllReviews] = useState<any[]>([])
  const [drillDown, setDrillDown] = useState<any[] | null>(null)
  const [drillTitle, setDrillTitle] = useState('')
  const [view, setView] = useState<'stats' | 'detail'>('stats')
  const [detail, setDetail] = useState<any>(null)
  const [msg, setMsg] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // 默认本月
  useEffect(() => {
    const now = new Date()
    const first = new Date(now.getFullYear(), now.getMonth(), 1)
    const s = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(first.getDate()).padStart(2, '0')}`
    const e = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    setStartDate(s); setEndDate(e)
    loadStats(s, e)
  }, [])

  async function loadStats(s: string, e: string) {
    setLoading(true); setStats(null)
    try {
      const qs = s ? `?start_date=${s}&end_date=${e}` : ''
      const data = await apiGet(`/dcp/stats${qs}`)
      // 前端解析评审人真实姓名（后端 OPFetch 调 ONES 内部 API 404）
      const tu = getTeamUUID()
      if (tu && data.reviewers?.list?.length) {
        try {
          const memRes = await fetch(`/project/api/project/team/${tu}/members`, { credentials: 'include' })
          if (memRes.ok) {
            const memJson = await memRes.json()
            const members = memJson?.members || []
            const nameMap = new Map<string, string>()
            for (const m of members) {
              if (m.uuid && m.name) nameMap.set(m.uuid, m.name)
            }
            data.reviewers.list = data.reviewers.list.map((rvr: any) => ({
              ...rvr,
              reviewer_name: nameMap.get(rvr.reviewer_uuid) || rvr.reviewer_name || rvr.reviewer_uuid,
            }))
          }
        } catch { /* 静默失败，保留 UUID */ }
      }
      setStats(data)
      // 同时加载全部评审用于穿透
      const revData = await apiGet('/dcp/reviews/team')
      const rawReviews = revData.reviews || []
      const fixedReviews = tu ? await hydrateProjectNames(tu, rawReviews) : rawReviews
      setAllReviews(fixedReviews)
    } catch (e: any) { setMsg('加载失败: ' + e.message) }
    finally { setLoading(false) }
  }

  function handleFilter(s: string, e: string) {
    setStartDate(s); setEndDate(e)
    loadStats(s, e)
  }

  // 穿透：根据过滤器从 allReviews 中筛选
  function drillDownBy(filter: { type: string; value: any }) {
    let filtered: any[] = []
    let title = ''
    if (filter.type === 'status') {
      filtered = allReviews.filter(r => r.status === filter.value)
      title = `${STATUS_LABELS[filter.value] || filter.value}的评审`
    } else if (filter.type === 'type') {
      filtered = allReviews.filter(r => (r.review_type || 'dcp') === filter.value)
      title = `${filter.value === 'tr' ? 'TR' : 'DCP'} 类型评审`
    } else if (filter.type === 'phase') {
      filtered = allReviews.filter(r => r.phase_code === filter.value)
      title = `阶段 ${filter.value} 评审`
    } else if (filter.type === 'project') {
      filtered = allReviews.filter(r => r.project_uuid === filter.value || r.project_identifier === filter.value)
      title = `项目 ${filter.value} 评审`
    } else if (filter.type === 'reviewer') {
      filtered = allReviews.filter(r => r.reviewer_uuids?.includes(filter.value))
      title = `评审人 ${filter.value} 参与的评审`
    } else if (filter.type === 'all') {
      filtered = allReviews
      title = '全部评审'
    }
    setDrillDown(filtered); setDrillTitle(title)
  }

  async function openDetail(rid: string) {
    setLoading(true); setMsg('')
    try {
      const data = await reviewApi.getReviewDetail(rid)
      const projKey = data.review?.project_uuid || ''
      if (projKey) {
        const tuid = getTeamUUID()
        if (tuid) {
          try {
            const exchanged = await exchangeProject(tuid, projKey)
            const project = exchanged?.uuid ? await fetchProjectByStamp(tuid, exchanged.uuid) : null
            if (project?.name) {
              data.review = { ...data.review, project_name: project.name, project_identifier: project.identifier || exchanged?.identifier || projKey }
            }
          } catch { /* 静默失败 */ }
        }
      }
      setDetail(data); setView('detail')
    } catch (e: any) { setMsg('加载详情失败: ' + e.message) }
    finally { setLoading(false) }
  }

  async function refreshDetail() {
    if (!detail?.review?.review_uuid) return
    try {
      const data = await reviewApi.getReviewDetail(detail.review.review_uuid)
      if (detail.review.project_name) {
        data.review = { ...data.review, project_name: detail.review.project_name, project_identifier: detail.review.project_identifier }
      }
      setDetail(data)
    } catch (e: any) { setMsg('刷新失败: ' + e.message) }
  }

  async function handleStart(rid: string) {
    try { await reviewApi.startReview(rid); refreshDetail() } catch (e: any) { setMsg('发起失败: ' + e.message) }
  }

  async function handleRecreate(rid: string) {
    try {
      const res = await reviewApi.recreateReview(rid, { project_identifier: detail?.review?.project_identifier || detail?.review?.project_uuid || '' }) as any
      await openDetail(res.review_uuid || rid)
    } catch (e: any) {
      setMsg('重新发起失败: ' + (e.message || '未知错误'))
    }
  }

  if (loading && view === 'stats' && !stats) return <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>加载中…</div>

  if (view === 'detail' && detail) {
    const rv = detail.review
    return (
      <div style={S.container}>
        <button style={{ ...S.backBtn, borderColor: '#1677ff', color: '#1677ff' }} onClick={() => { setView('stats'); setDetail(null); loadStats(startDate, endDate) }}>← 返回报表</button>
        <ReviewDetail
          projectUuid={rv.project_uuid || ''} projectKey={rv.project_identifier || rv.project_uuid || ''}
          componentUuid="" viewUuid="" data={detail}
          onBack={() => { setView('stats'); setDetail(null); loadStats(startDate, endDate) }}
          onRefresh={refreshDetail} onStart={handleStart} onRecreate={handleRecreate} msg={msg} setMsg={setMsg}
        />
      </div>
    )
  }

  if (!stats) return <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>暂无数据</div>

  const trend = stats.trend || {}
  const reviewersData = stats.reviewers || {}
  const projectsData = stats.projects || {}
  const reviewerList = reviewersData.list || []
  const projectList = projectsData.list || []

  // 饼图数据
  const statusPieData = [
    { label: '草稿', value: trend.draft || 0, color: '#999', filter: { type: 'status', value: 'draft' } },
    { label: '评审中', value: trend.reviewing || 0, color: '#1677ff', filter: { type: 'status', value: 'reviewing' } },
    { label: '已完成', value: trend.completed || 0, color: '#52c41a', filter: { type: 'status', value: 'completed' } },
    { label: '已否决', value: trend.rejected || 0, color: '#ff4d4f', filter: { type: 'status', value: 'rejected' } },
  ]

  // 阶段柱状图
  const phaseBarData = (trend.phase_trend || []).map((p: any) => ({
    label: p.phase_code, value: p.count, filter: { type: 'phase', value: p.phase_code }
  }))

  // 周趋势折线图数据
  const weeklyData = (trend.weekly_trend || []).map((w: any) => ({
    week: w.week, count: w.count,
  }))

  // 项目柱状图
  const projectBarData = projectList.map((p: any) => ({
    label: p.project_name || p.project_uuid, value: p.total, filter: { type: 'project', value: p.project_uuid }
  }))

  return (
    <div style={S.container}>
      <div style={S.sectionTitle}>
        <span>评审统计总览</span>
        <button style={S.btn} onClick={() => loadStats(startDate, endDate)}>刷新</button>
      </div>

      {msg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#cf1322' }}>{msg}</div>}

      <TimeFilter startDate={startDate} endDate={endDate} onFilter={handleFilter} />

      {/* 统计卡片 */}
      <div style={S.statsBar}>
        <div style={S.statCard} onClick={() => drillDownBy({ type: 'all', value: '' })}>
          <div style={{ ...S.statNum, color: '#1677ff' }}>{trend.total || 0}</div>
          <div style={S.statLabel}>全部评审</div>
        </div>
        <div style={S.statCard} onClick={() => drillDownBy({ type: 'status', value: 'reviewing' })}>
          <div style={{ ...S.statNum, color: '#faad14' }}>{trend.reviewing || 0}</div>
          <div style={S.statLabel}>评审中</div>
        </div>
        <div style={S.statCard} onClick={() => drillDownBy({ type: 'status', value: 'completed' })}>
          <div style={{ ...S.statNum, color: '#52c41a' }}>{trend.completed || 0}</div>
          <div style={S.statLabel}>已完成</div>
        </div>
        <div style={S.statCard} onClick={() => drillDownBy({ type: 'status', value: 'rejected' })}>
          <div style={{ ...S.statNum, color: '#ff4d4f' }}>{trend.rejected || 0}</div>
          <div style={S.statLabel}>已否决</div>
        </div>
        <div style={S.statCard}>
          <div style={{ ...S.statNum, color: '#722ed1' }}>{reviewersData.total || 0}</div>
          <div style={S.statLabel}>参与评审人</div>
        </div>
      </div>

      {/* 穿透列表 */}
      {drillDown !== null && (
        <div style={S.section}>
          <DrillDownList reviews={drillDown} onOpenDetail={openDetail}
            onBack={() => setDrillDown(null)} title={drillTitle} />
        </div>
      )}

      {/* 报表一：评审趋势统计 */}
      <div style={S.section}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>📊 评审趋势统计</div>
        <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 300px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>状态分布</div>
            <PieChart data={statusPieData} onClick={(f) => drillDownBy(f)} />
          </div>
          <div style={{ flex: '1 1 300px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>类型分布</div>
            <BarChart data={[
              { label: 'DCP', value: (trend.type_trend?.dcp || 0), filter: { type: 'type', value: 'dcp' } },
              { label: 'TR', value: (trend.type_trend?.tr || 0), filter: { type: 'type', value: 'tr' } },
            ]} color="#1677ff" onBarClick={(f) => drillDownBy(f)} />
          </div>
        </div>
        {weeklyData.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>周趋势</div>
            <LineChart data={weeklyData} color="#722ed1" />
          </div>
        )}
        {phaseBarData.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>阶段分布</div>
            <BarChart data={phaseBarData} color="#faad14" onBarClick={(f) => drillDownBy(f)} />
          </div>
        )}
      </div>

      {/* 报表二：评审人参与统计 */}
      <div style={S.section}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>👥 评审人参与统计</div>
        {reviewerList.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>暂无评审人数据</div>
        ) : (
          <table style={S.table}><thead><tr>
            <th style={S.th}>评审人</th>
            <th style={S.th}>角色</th>
            <th style={{ ...S.th, textAlign: 'center' }}>参与次数</th>
            <th style={{ ...S.th, textAlign: 'center' }}>已提交</th>
            <th style={{ ...S.th, textAlign: 'center' }}>首轮通过</th>
            <th style={{ ...S.th, textAlign: 'center' }}>首轮驳回</th>
            <th style={{ ...S.th, textAlign: 'center' }}>首轮通过率</th>
            <th style={{ ...S.th, textAlign: 'center' }}>驳回率</th>
          </tr></thead><tbody>
            {reviewerList.map((rvr: any, i: number) => (
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                onClick={() => drillDownBy({ type: 'reviewer', value: rvr.reviewer_uuid })}>
                <td style={S.td}>{rvr.reviewer_name}</td>
                <td style={{ ...S.td, fontSize: 12, color: '#8c8c8c' }}>{(rvr.roles || []).join(', ')}</td>
                <td style={{ ...S.td, textAlign: 'center', fontWeight: 600 }}>{rvr.total_participated}</td>
                <td style={{ ...S.td, textAlign: 'center' }}>{rvr.submitted_count}</td>
                <td style={{ ...S.td, textAlign: 'center', color: '#52c41a' }}>{rvr.first_round_pass}</td>
                <td style={{ ...S.td, textAlign: 'center', color: '#ff4d4f' }}>{rvr.first_round_reject}</td>
                <td style={{ ...S.td, textAlign: 'center' }}>
                  <span style={{ ...S.statusTag(rvr.first_round_pass_rate >= 80 ? '#52c41a' : rvr.first_round_pass_rate >= 50 ? '#faad14' : '#ff4d4f') }}>
                    {rvr.first_round_pass_rate}%
                  </span>
                </td>
                <td style={{ ...S.td, textAlign: 'center' }}>
                  <span style={{ ...S.statusTag(rvr.reject_rate <= 10 ? '#52c41a' : rvr.reject_rate <= 30 ? '#faad14' : '#ff4d4f') }}>
                    {rvr.reject_rate}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* 报表三：项目维度统计 */}
      <div style={S.section}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>📁 项目维度统计</div>
        {projectList.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>暂无项目数据</div>
        ) : (
          <div>
            <div style={{ marginBottom: 16 }}>
              <BarChart data={projectBarData} color="#1677ff" onBarClick={(f) => drillDownBy(f)} />
            </div>
            <table style={S.table}><thead><tr>
              <th style={S.th}>项目</th>
              <th style={{ ...S.th, textAlign: 'center' }}>评审数</th>
              <th style={{ ...S.th, textAlign: 'center' }}>已完成</th>
              <th style={{ ...S.th, textAlign: 'center' }}>通过数</th>
              <th style={{ ...S.th, textAlign: 'center' }}>通过率</th>
            </tr></thead><tbody>
              {projectList.map((p: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
                  onClick={() => drillDownBy({ type: 'project', value: p.project_uuid })}>
                  <td style={S.td}>{p.project_name || p.project_uuid}</td>
                  <td style={{ ...S.td, textAlign: 'center', fontWeight: 600 }}>{p.total}</td>
                  <td style={{ ...S.td, textAlign: 'center' }}>{p.completed}</td>
                  <td style={{ ...S.td, textAlign: 'center', color: '#52c41a' }}>{p.passed}</td>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    <span style={{ ...S.statusTag(p.pass_rate >= 80 ? '#52c41a' : p.pass_rate >= 50 ? '#faad14' : '#ff4d4f') }}>
                      {p.pass_rate}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
      </div>
    </div>
  )
}

ReactDOM.render(<App />, document.getElementById('ones-mf-root'))

export { App as TeamOverview }
