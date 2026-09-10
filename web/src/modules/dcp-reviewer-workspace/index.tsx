import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom'
import { getTeamUUID } from '../../api'
import {
 findConfiguredIssueType,
 remediationTypeBlockedMessage,
 resolveProjectIssueTypes,
} from '../../project-issue-types'

// ============================================================
// 复用 dcp-review-tab 的 API 层
// ============================================================
let _teamUUID = ''
function tu() { if (!_teamUUID) _teamUUID = getTeamUUID(); return _teamUUID }

async function callApi<T = any>(endpoint: string, method = 'GET', body?: any): Promise<T> {
 const url = `/project/api/project/team/${tu()}${endpoint}`
 const opts: any = { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'Ones-Plugin-Id': '709xehle' } }
 if (body) opts.body = JSON.stringify(body)
 const res = await fetch(url, opts)
 if (!res.ok) {
 let errBody: any = {}
 try { errBody = await res.json() } catch {}
 const data = errBody.body || errBody.data || errBody
 const err = new Error(data?.error || `${res.status}`) as any
 if (data?.fallback_url) err.fallback_url = data.fallback_url
 throw err
 }
 const json = await res.json()
 return json.body || json.data || json
}

// ============================================================
// 客户端批量解析项目名称（短标识 → 真实 UUID → 项目名称）
// ============================================================
async function resolveProjectNames(reviews: any[]): Promise<Record<string, string>> {
 const tuid = tu()
 const projectUuids = [...new Set(reviews.map(r => r.project_uuid).filter(Boolean))]
 const nameMap: Record<string, string> = {}
 await Promise.all(projectUuids.map(async (puuid) => {
 try {
 // exchange API: 短标识 → 真实 UUID + identifier
 const exchRes = await fetch(`/project/api/ones-project/team/${tuid}/projects/exchange/${puuid}`, { credentials: 'include' })
 if (!exchRes.ok) return
 const exch = await exchRes.json()
 const exchData = exch?.data || exch || {}
 const realUuid = exchData.project_uuid || ''
 const identifier = exchData.identifier || ''
 if (realUuid) {
 // stamps API: 真实 UUID → 项目名称
 const stampRes = await fetch(`/project/api/project/team/${tuid}/project/${realUuid}/stamps/data?t=project`, {
 method: 'POST', credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ project: 0 }),
 })
 if (stampRes.ok) {
 const sdata = await stampRes.json()
 const proj = sdata?.data?.project?.projects?.[0] || sdata?.project?.projects?.[0]
 if (proj?.name) { nameMap[puuid] = proj.name; return }
 }
 }
 // 兜底：如果有 identifier 但没有 name，用 identifier
 if (identifier) nameMap[puuid] = identifier
 } catch {}
 }))
 return nameMap
}

async function copyReviewLinkToClipboard(text: string): Promise<boolean> {
 try {
  await navigator.clipboard.writeText(text)
  return true
 } catch {
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); return true } catch { return false }
  finally { document.body.removeChild(ta) }
 }
}

// ============================================================
// 常量
// ============================================================
const MATERIAL_STATUS: Record<string, { text: string; color: string; bg: string }> = {
 pending: { text: '待提交', color: '#999', bg: '#fafafa' },
 submitted: { text: '已提交', color: '#1677ff', bg: '#e6f4ff' },
 approved: { text: '已通过', color: '#52c41a', bg: '#f6ffed' },
 rejected: { text: '需修改', color: '#ff4d4f', bg: '#fff2f0' },
}

// ============================================================
// 样式
// ============================================================
const S: Record<string, any> = {
 container: { padding: 20, fontFamily: 'sans-serif', fontSize: 14, color: '#333', maxWidth: 900, margin: '0 auto' },
 card: { padding: 16, background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8', marginBottom: 16 },
 tableWrap: { width: '100%', overflowX: 'auto' as any, overflowY: 'visible' as any },
 sectionTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 12px 0' } as React.CSSProperties,
 table: { width: '100%', borderCollapse: 'collapse' as any, fontSize: 13 },
 th: { padding: '8px 12px', textAlign: 'left' as any, background: '#fafafa', borderBottom: '1px solid #e8e8e8' },
 td: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0' },
 input: { padding: '6px 10px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13, width: '100%', boxSizing: 'border-box' as any },
 select: { padding: '6px 10px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13 },
 textarea: { padding: '6px 10px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13, width: '100%', resize: 'vertical' as any, boxSizing: 'border-box' as any },
 btn: (p: boolean): React.CSSProperties => ({ padding: '6px 16px', border: p ? 'none' : '1px solid #d9d9d9', borderRadius: 4, background: p ? '#1677ff' : '#fff', color: p ? '#fff' : '#333', cursor: 'pointer', fontSize: 13, marginRight: 8 }),
 formGroup: { marginBottom: 10 },
 label: { display: 'block', marginBottom: 4, fontWeight: 500, fontSize: 13 },
 statusTag: (c: string): React.CSSProperties => ({ display: 'inline-block', padding: '2px 10px', borderRadius: 4, fontSize: 12, background: `${c}1a`, color: c, fontWeight: 600 }),
}

// ============================================================
// 搜索型下拉选择器（用于工作项类型等长列表）
// ============================================================
const SearchableTypePicker: React.FC<{
 types: { scope_uuid: string; issue_type_uuid: string; name: string }[]
 value: string
 onChange: (scope_uuid: string, issue_type_uuid: string) => void
}> = ({ types, value, onChange }) => {
 const [kw, setKw] = useState('')
 const [open, setOpen] = useState(false)
 const timerRef = useRef<any>(null)

 const selected = types.find(t => t.scope_uuid === value)
 const displayName = selected?.name || (value ? value : '— 默认 —')

 const filtered = kw.trim()
 ? types.filter(t => t.name.toLowerCase().includes(kw.trim().toLowerCase())).slice(0, 30)
 : types.slice(0, 30)

 if (selected && !open) {
 return (
 <div style={{ position: 'relative' }}>
 <div style={{
 padding: '6px 10px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13,
 cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
 background: '#fff', minWidth: 160,
 }} onClick={() => setOpen(true)}>
 <span>{displayName}</span>
 <span style={{ color: '#999', fontSize: 11 }}>▼</span>
 </div>
 </div>
 )
 }

 return (
 <div style={{ position: 'relative' }}>
 <input
 style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid #1677ff', fontSize: 13, width: 180, boxSizing: 'border-box' }}
 value={kw}
 autoFocus
 placeholder={displayName || '搜索类型…'}
 onChange={e => {
 setKw(e.target.value)
 if (timerRef.current) clearTimeout(timerRef.current)
 timerRef.current = setTimeout(() => setOpen(true), 200)
 }}
 onFocus={() => { setKw(''); setOpen(true) }}
 onBlur={() => setTimeout(() => setOpen(false), 200)}
 />
 {open && filtered.length > 0 && (
 <div style={{
 position: 'absolute', top: '100%', left: 0, zIndex: 1000, maxHeight: 240,
 overflowY: 'auto', background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4,
 boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minWidth: 200,
 }}>
 {filtered.map(t => (
 <div key={t.scope_uuid}
 onMouseDown={e => { e.preventDefault(); onChange(t.scope_uuid, t.issue_type_uuid); setKw(''); setOpen(false) }}
 style={{
 padding: '6px 10px', cursor: 'pointer', fontSize: 13,
 borderBottom: '1px solid #f0f0f0',
 background: t.scope_uuid === value ? '#e6f4ff' : '#fff',
 }}>
 {t.name}
 </div>
 ))}
 </div>
 )}
 {open && filtered.length === 0 && (
 <div style={{
 position: 'absolute', top: '100%', left: 0, zIndex: 1000,
 background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4,
 padding: '8px 12px', fontSize: 12, color: '#999', minWidth: 160,
 }}>无匹配结果</div>
 )}
 </div>
 )
}

// ============================================================
// 主组件
// ============================================================
const App: React.FC = () => {
 const [loading, setLoading] = useState(true)
 const [msg, setMsg] = useState('')
 const [currentUser, setCurrentUser] = useState<{ uuid: string; name: string }>({ uuid: '', name: '' })
 const [pendingReviews, setPendingReviews] = useState<any[]>([])
 const [resolutionPendingReviews, setResolutionPendingReviews] = useState<any[]>([])
 const [doneReviews, setDoneReviews] = useState<any[]>([])
 const [myTab, setMyTab] = useState<'pending' | 'resolution' | 'done'>('pending')
 const [selected, setSelected] = useState<any>(null)
 const [detailMode, setDetailMode] = useState<'review' | 'resolution' | 'readonly'>('review')
 const [directLink, setDirectLink] = useState(false)
 const [filterNumber, setFilterNumber] = useState('')
 const [filterPhase, setFilterPhase] = useState('')
 const [filterTitle, setFilterTitle] = useState('')
 const [filterProject, setFilterProject] = useState('')
 const [filterType, setFilterType] = useState('')

 useEffect(() => { init() }, [])

 async function init() {
 setLoading(true)
 try {
 const meRes = await fetch('/project/api/project/users/me', { credentials: 'include' })
 let meUuid = ''
 if (meRes.ok) {
 const me = await meRes.json()
 setCurrentUser({ uuid: me.uuid || '', name: me.name || '' })
 meUuid = me.uuid || ''
 }
 if (meUuid) {
 const data = await callApi('/dcp/reviews/my')
 const allReviews = [...(data.review_pending || data.pending || []), ...(data.resolution_pending || []), ...(data.done || [])]
 const projectNameMap = await resolveProjectNames(allReviews)
 const enrich = (arr: any[]) => arr.map(r => ({ ...r, project_name: projectNameMap[r.project_uuid] || r.project_name || r.project_uuid }))
 setPendingReviews(enrich(data.review_pending || data.pending || []))
 setResolutionPendingReviews(enrich(data.resolution_pending || []))
 setDoneReviews(enrich(data.done || []))
 }
 // 检查 URL 参数，直接定位评审单
 try {
 const params = new URLSearchParams(window.location.search)
 const rid = params.get('review_uuid')
 if (rid) {
 setDirectLink(true)
 const data = await callApi(`/dcp/review/${rid}`)
 setSelected(data)
 }
 } catch {}
 } catch (e: any) { setMsg(`加载失败: ${e.message}`) }
 finally { setLoading(false) }
 }

 async function openReview(rv: any, mode?: 'review' | 'resolution' | 'readonly') {
 setLoading(true)
 try {
 const data = await callApi(`/dcp/review/${rv.review_uuid}`)
 setSelected(data)
 if (mode) setDetailMode(mode)
 } catch (e: any) { setMsg(`加载评审详情失败: ${e.message}`) }
 finally { setLoading(false) }
 }

 if (loading) return <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中…</div>
 if (msg && !selected) return <div style={{ ...S.container, textAlign: 'center', color: '#cf1322' }}>{msg}</div>

 if (selected) {
 return <ReviewerWorkspace
 key={`${selected.review.review_uuid}_${selected.review.round_no || 1}`}
 data={selected}
 currentUser={currentUser}
 directLink={directLink}
 mode={detailMode}
 onBack={() => { setSelected(null); setDirectLink(false); setDetailMode('review'); init() }}
 onRefresh={async () => {
 const data = await callApi(`/dcp/review/${selected.review.review_uuid}`)
 setSelected(data)
 }}
 />
 }

 return (
 <div style={S.container}>
 <h3 style={{ fontSize: 18, margin: '0 0 20px 0' }}>DCP 评审工作台</h3>
 {currentUser.name && <div style={{ marginBottom: 16, fontSize: 13, color: '#666' }}>{currentUser.name}，你好</div>}

 {/* 待我评审 / 待我决议 / 已办 Tab */}
 <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e8e8e8', marginBottom: 16 }}>
 <button
 onClick={() => setMyTab('pending')}
 style={{ padding: '8px 20px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, borderBottom: myTab === 'pending' ? '2px solid #1677ff' : '2px solid transparent', color: myTab === 'pending' ? '#1677ff' : '#666', fontWeight: myTab === 'pending' ? 600 : 400 }}
 >
 待我评审 ({pendingReviews.length})
 </button>
 <button
 onClick={() => setMyTab('resolution')}
 style={{ padding: '8px 20px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, borderBottom: myTab === 'resolution' ? '2px solid #faad14' : '2px solid transparent', color: myTab === 'resolution' ? '#faad14' : '#666', fontWeight: myTab === 'resolution' ? 600 : 400 }}
 >
 待我决议 ({resolutionPendingReviews.length})
 </button>
 <button
 onClick={() => setMyTab('done')}
 style={{ padding: '8px 20px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, borderBottom: myTab === 'done' ? '2px solid #1677ff' : '2px solid transparent', color: myTab === 'done' ? '#1677ff' : '#666', fontWeight: myTab === 'done' ? 600 : 400 }}
 >
 已办 ({doneReviews.length})
 </button>
 </div>

 {(() => {
 const displayReviews = myTab === 'pending' ? pendingReviews : myTab === 'resolution' ? resolutionPendingReviews : doneReviews
 if (displayReviews.length === 0) {
 return (
 <div style={{ ...S.card, textAlign: 'center', padding: 40, color: '#999' }}>
 <div style={{ fontSize: 16, marginBottom: 8 }}>
 {myTab === 'pending' ? '暂无待我评审' : myTab === 'resolution' ? '暂无待我决议' : '暂无已办评审'}
 </div>
 <div style={{ fontSize: 13 }}>
 {myTab === 'pending' ? '当有评审单进入评审中状态后，将显示在这里' : myTab === 'resolution' ? '当前置评审人完成评审后，待决议项将显示在这里' : '完成评审后，将显示在这里'}
 </div>
 </div>
 )
 }
 const phaseOptions = [...new Set(displayReviews.map(r => r.phase_code).filter(Boolean))]
 const projectOptions = [...new Set(displayReviews.map(r => r.project_name || r.project_uuid).filter(Boolean))]
 const filteredReviews = displayReviews.filter(r => {
 if (filterNumber && !(r.review_number || '').toLowerCase().includes(filterNumber.trim().toLowerCase())) return false
 if (filterPhase && r.phase_code !== filterPhase) return false
 if (filterTitle && !(r.review_title || '').toLowerCase().includes(filterTitle.trim().toLowerCase())) return false
 if (filterProject && (r.project_name || r.project_uuid) !== filterProject) return false
 if (filterType && (r.review_type || 'dcp') !== filterType) return false
 return true
 })
 return (
 <React.Fragment>
 <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
 <select style={S.select} value={filterType} onChange={e => setFilterType(e.target.value)}>
 <option value="">全部类型</option>
 <option value="dcp">DCP</option>
 <option value="tr">TR</option>
 </select>
 <input style={{ ...S.input, width: 130 }} placeholder="筛选编号" value={filterNumber} onChange={e => setFilterNumber(e.target.value)} />
 <select style={S.select} value={filterPhase} onChange={e => setFilterPhase(e.target.value)}>
 <option value="">全部阶段</option>
 {phaseOptions.map(p => <option key={p} value={p}>{p}</option>)}
 </select>
 <input style={{ ...S.input, width: 180 }} placeholder="筛选标题" value={filterTitle} onChange={e => setFilterTitle(e.target.value)} />
 <select style={S.select} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
 <option value="">全部项目</option>
 {projectOptions.map(p => <option key={p} value={p}>{p}</option>)}
 </select>
 </div>
 {filteredReviews.length === 0 ? (
 <div style={{ ...S.card, textAlign: 'center', padding: 32, color: '#999', fontSize: 13 }}>无匹配结果</div>
 ) : (
 <div style={S.card}>
 <div style={S.tableWrap}>
 <table style={S.table}>
 <thead><tr>
 <th style={S.th}>编号</th><th style={{ ...S.th, width: 70, textAlign: 'center' }}>类型</th><th style={S.th}>阶段</th><th style={S.th}>标题</th><th style={{ ...S.th, width: 120 }}>项目</th>
 <th style={{ ...S.th, width: 100, textAlign: 'center' }}>评审进度</th>
 {myTab === 'resolution' && <th style={{ ...S.th, width: 90, textAlign: 'center' }}>操作</th>}
 {myTab === 'done' && <th style={{ ...S.th, width: 80, textAlign: 'center' }}>我的结论</th>}
 </tr></thead>
 <tbody>
 {filteredReviews.map((r: any, i: number) => (
 <tr key={i} style={{ cursor: 'pointer' }} onClick={() => openReview(r, myTab === 'pending' ? 'review' : myTab === 'resolution' ? 'resolution' : 'readonly')}>
 <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12, color: '#1677ff', fontWeight: 600 }}>
 <span style={{ cursor: 'pointer' }} title="点击复制编号" onClick={async (e) => { e.stopPropagation(); await copyReviewLinkToClipboard(r.review_number || r.review_uuid) }}>{r.review_number || '-'}</span>
 </td>
 <td style={{ ...S.td, textAlign: 'center' }}>
 <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: (r.review_type || 'dcp') === 'tr' ? '#f9f0ff' : '#e6f4ff', color: (r.review_type || 'dcp') === 'tr' ? '#722ed1' : '#1677ff' }}>{(r.review_type || 'dcp') === 'tr' ? 'TR' : 'DCP'}</span>
 </td>
 <td style={{ ...S.td, fontWeight: 600 }}>
 {r.phase_name || r.phase_code}
 </td>
 <td style={{ ...S.td, color: '#1677ff', textDecoration: 'underline' }}>{r.review_title || r.review_uuid}</td>
 <td style={{ ...S.td, fontSize: 12, color: '#666' }}>{r.project_name || r.project_uuid}</td>
 <td style={{ ...S.td, textAlign: 'center', fontSize: 12 }}>
 {r.reviewer_done}/{r.reviewer_total} 已提交
 {r.resolution_pending && <span style={{ display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 3, background: '#fff7e6', color: '#faad14', fontSize: 10, fontWeight: 600 }}>待决议</span>}
 </td>
 {myTab === 'resolution' && (
 <td style={{ ...S.td, textAlign: 'center' }}>
 <button style={{ ...S.btn(true), fontSize: 12, padding: '2px 10px' }} onClick={(e) => { e.stopPropagation(); openReview(r, 'resolution') }}>去发布决议</button>
 </td>
 )}
 {myTab === 'done' && (
 <td style={{ ...S.td, textAlign: 'center', fontSize: 12 }}>
 <span style={{ color: r.my_conclusion === 'pass' ? '#52c41a' : r.my_conclusion === 'fail' ? '#ff4d4f' : '#faad14' }}>
 {r.my_conclusion === 'pass' ? '' : r.my_conclusion === 'conditional_pass' ? '' : ''}
 </span>
 </td>
 )}
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 </React.Fragment>
 )
 })()}
 </div>
 )
}

// ============================================================
// UserPicker（搜索 ONES 团队成员）
// ============================================================
let _memberCache: any[] | null = null
async function fetchMembers() {
 if (_memberCache) return _memberCache
 try {
 const res = await fetch(`/project/api/project/team/${tu()}/members?limit=200`, { credentials: 'include' })
 if (res.ok) {
 const json = await res.json()
 const list = json.members || json.data || json || []
 _memberCache = (Array.isArray(list) ? list : []).map((u: any) => ({
 uuid: u.uuid || '', name: u.name || u.email || u.uuid || '', email: u.email || '',
 }))
 }
 } catch { _memberCache = [] }
 return _memberCache || []
}

const UserPicker: React.FC<{ value: string; onChange: (u: { uuid: string; name: string }) => void; placeholder?: string; displayName?: string }> = ({ value, onChange, placeholder = '搜索用户…', displayName }) => {
 const [results, setResults] = useState<any[]>([])
 const [open, setOpen] = useState(false)
 const [selName, setSelName] = useState('')
 const timerRef = React.useRef<any>(null)
 const inputRef = React.useRef<HTMLInputElement>(null)

 // 外部 value 清空时同步重置内部状态
 useEffect(() => {
   if (!value) {
     setSelName('')
     if (inputRef.current) inputRef.current.value = ''
   }
 }, [value])

 // 已选用户名：优先用外部传入的 displayName，其次用内部 selName
 const shownName = value ? (displayName || selName || '') : ''

 async function doSearch(k: string) {
 if (k.trim().length < 1) { setResults([]); setOpen(false); return }
 const members = await fetchMembers()
 const kwLower = k.trim().toLowerCase()
 const filtered = members.filter((u: any) => u.name.toLowerCase().includes(kwLower) || u.email.toLowerCase().includes(kwLower)).slice(0, 20)
 setResults(filtered)
 setOpen(filtered.length > 0)
 }

 if (shownName) {
 return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
 <span style={{ fontSize: 12, background: '#e6f4ff', padding: '2px 8px', borderRadius: 3 }}>{shownName}</span>
 <button onClick={() => { onChange({ uuid: '', name: '' }); setSelName(''); if (inputRef.current) inputRef.current.value = '' }} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#ff4d4f', fontSize: 14, padding: 0 }}>×</button>
 </div>
 }

 return <div style={{ position: 'relative' }}>
 <input ref={inputRef} style={{ ...S.input, width: 120 }} onChange={e => { const v = e.target.value; if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = setTimeout(() => doSearch(v), 300) }} onFocus={() => { if (results.length > 0) setOpen(true) }} onBlur={() => setTimeout(() => setOpen(false), 200)} placeholder={placeholder} />
 {open && results.length > 0 && <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1000, maxHeight: 180, overflowY: 'auto', background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', minWidth: 200 }}>
 {results.map((u: any) => <div key={u.uuid} onMouseDown={e => { e.preventDefault(); onChange({ uuid: u.uuid, name: u.name }); setSelName(u.name); if (inputRef.current) inputRef.current.value = ''; setResults([]); setOpen(false) }} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between' }} onMouseEnter={e => { (e.target as HTMLElement).style.background = '#f5f5f5' }} onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent' }}>
 <span>{u.name}</span><span style={{ color: '#999', fontSize: 11 }}>{u.email}</span>
 </div>)}
 </div>}
 </div>
}

// ============================================================
// 评审工作台（评审人视角）
// ============================================================
const ReviewerWorkspace: React.FC<{
 data: any
 currentUser: { uuid: string; name: string }
 directLink?: boolean
 mode?: 'review' | 'resolution' | 'readonly'
 onBack: () => void
 onRefresh: () => void
}> = ({ data, currentUser, directLink, mode = 'review', onBack, onRefresh }) => {
 const mats = data.materials || []
 const inds = data.indicators || []
 const rv = data.review
 const reviewers = data.reviewers || []
 const allIssues = data.linked_issues || []
 // 自动匹配当前用户的评审角色
 const myReviewer = reviewers.find((r: any) => r.reviewer_uuid === currentUser.uuid)
 const myRole = myReviewer?.role_name || ''
 const _wsRoundNo = rv.round_no || 1
 const alreadySubmitted = !!(myReviewer?.submitted_at > 0 && (myReviewer?.round_no || 1) === _wsRoundNo)

 // 评审人只看自己创建的整改项（决议人看全部，在渲染时用 canPublish 判断）
 const myIssues = allIssues.filter((iss: any) => iss.linked_by === currentUser.uuid)

 const [opinionForm, setOpinionForm] = useState({
 reviewer_uuid: currentUser.uuid || '',
 role_name: myRole,
 conclusion: alreadySubmitted ? (myReviewer?.conclusion || '') : '',
 risk_level: alreadySubmitted ? (myReviewer?.risk_level || 'medium') : 'medium',
 opinion_summary: alreadySubmitted ? (myReviewer?.opinion_summary || '') : '',
 })
 const [opinionMsg, setOpinionMsg] = useState('')
 const [submittingOpinion, setSubmittingOpinion] = useState(false)
 const [opinionToast, setOpinionToast] = useState('')
 const [resolutionForm, setResolutionForm] = useState({ final_conclusion: '', condition_notes: '' })
 const [resolving, setResolving] = useState(false)
 const [resolutionMsg, setResolutionMsg] = useState('')
 const [resolvingProject, setResolvingProject] = useState(false)
 const [createIssueForm, setCreateIssueForm] = useState({ title: '', issue_type_scope_uuid: '', issue_type_id: '', project_uuid: rv.project_uuid || '', assignee_uuid: currentUser.uuid || '' })
 const [creating, setCreating] = useState(false)
 const [createIssueMsg, setCreateIssueMsg] = useState('')
 const [createIssueFallback, setCreateIssueFallback] = useState('')
 const [issueTypes, setIssueTypes] = useState<any[]>([])
 const [loadingTypes, setLoadingTypes] = useState(false)
 const [projectDisplayName, setProjectDisplayName] = useState(rv.project_uuid || '')
 const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
 const [previewLoading, setPreviewLoading] = useState(false)
 const [copyToast, setCopyToast] = useState('')
 const [resolutionRule, setResolutionRule] = useState<any>(null)
 const [configRoles, setConfigRoles] = useState<any[]>([])
 const [remediationIssueType, setRemediationIssueType] = useState('')
 const [remediationIssueTypeUuid, setRemediationIssueTypeUuid] = useState('')
 const [remediationConfigLoaded, setRemediationConfigLoaded] = useState(false)
 const [projectTypesVerified, setProjectTypesVerified] = useState(false)

 // 加载当前评审类型的决议规则配置 + 角色列表 + 整改项类型
 const _rvReviewType = (rv.review_type || 'dcp')
 useEffect(() => {
   callApi('/dcp/config').then((c: any) => {
     const rules = c.resolution_rule_config || {}
     setResolutionRule(rules[_rvReviewType] || null)
     setConfigRoles((c.roles || []).filter((r: any) => (r.review_type || 'dcp') === _rvReviewType))
     setRemediationIssueType(c.config?.remediation_issue_type || '')
     setRemediationIssueTypeUuid(c.config?.remediation_issue_type_uuid || '')
   }).catch(() => {}).finally(() => setRemediationConfigLoaded(true))
 }, [_rvReviewType])
 const canPublish = !!resolutionRule && (resolutionRule.publisher?.role || '') === myRole
 const configuredProjectType = findConfiguredIssueType(issueTypes, remediationIssueType, remediationIssueTypeUuid)
 const remediationTypeStatus: 'loading' | 'available' | 'missing' | 'unknown' | 'unconfigured' =
   !remediationConfigLoaded || loadingTypes ? 'loading'
     : !remediationIssueType && !remediationIssueTypeUuid ? 'unconfigured'
       : !projectTypesVerified ? 'unknown'
         : configuredProjectType ? 'available' : 'missing'
 const remediationTypeMessage = remediationTypeBlockedMessage(
   remediationTypeStatus,
   remediationIssueType || remediationIssueTypeUuid,
 )
 const remediationCreationBlocked = remediationTypeStatus === 'loading'
   || remediationTypeStatus === 'missing'
   || remediationTypeStatus === 'unknown'

// 前端复用 isResolutionReady 逻辑（与后端 listMyReviews 保持一致）
// 排除决议角色——决议人不参与前置评审提交判断
const resolutionReady = (() => {
  if (!resolutionRule) return false
  const publisherRole = resolutionRule.publisher?.role || (Array.isArray(resolutionRule.publisher?.roles) ? resolutionRule.publisher.roles[0] : '') || ''
  const frontReviewers = publisherRole ? reviewers.filter((r: any) => r.role_name !== publisherRole) : reviewers
  const submitMode = resolutionRule?.submitRequirement?.mode || 'must_vote_roles'
  if (submitMode === 'publisher_only') return true
  if (submitMode === 'all_reviewers') {
    return frontReviewers.length > 0 && frontReviewers.every((r: any) => r.submitted_at > 0)
  }
  if (submitMode === 'vote_scope_roles') {
    const scope = resolutionRule.passRule?.voteScope || {}
    const vsMode = scope.mode || 'must_vote_roles'
    const excludeRoles = scope.excludeRoles || []
    const selectedRoles = scope.selectedRoles || []
    let scopeRoleNames: string[]
    if (vsMode === 'all_reviewers') scopeRoleNames = configRoles.map((r: any) => r.role_name)
    else if (vsMode === 'selected_roles') scopeRoleNames = configRoles.filter((r: any) => selectedRoles.includes(r.role_name)).map((r: any) => r.role_name)
    else scopeRoleNames = configRoles.filter((r: any) => r.must_vote).map((r: any) => r.role_name)
    scopeRoleNames = scopeRoleNames.filter((n: string) => !excludeRoles.includes(n))
    const scopeReviewers = frontReviewers.filter((r: any) => scopeRoleNames.includes(r.role_name))
    if (scopeReviewers.length === 0) return false
    return scopeReviewers.every((r: any) => r.submitted_at > 0)
  }
  // must_vote_roles（含 must_vote 或 has_veto 的角色）
  const mustVoteNames = configRoles.filter((r: any) => r.must_vote || r.has_veto).map((r: any) => r.role_name)
  const mustReviewers = frontReviewers.filter((r: any) => mustVoteNames.includes(r.role_name))
  if (mustReviewers.length === 0) return false
  return mustReviewers.every((r: any) => r.submitted_at > 0)
})()

const isResolutionMode = mode === 'resolution'
const _wsEffState = rv.effective_state || rv.review_state || rv.status
const _isReReviewing = _wsEffState === 're_reviewing'
const _prevResolution = (data.resolutions || []).find((r: any) => (r.round_no || 1) === _wsRoundNo - 1)
const canPublishResolution = canPublish && rv.status === 'reviewing' && resolutionReady && !data.resolution

 // 复制编号到剪贴板
 async function handleCopyReviewLink(reviewNumber: string) {
 const ok = await copyReviewLinkToClipboard(reviewNumber)
 if (ok) setCopyToast('已复制编号')
 setTimeout(() => setCopyToast(''), 2000)
 }

 // 同步 currentUser
 useEffect(() => {
 if (currentUser.uuid && !opinionForm.reviewer_uuid) {
 setOpinionForm(f => ({ ...f, reviewer_uuid: currentUser.uuid }))
 }
 }, [currentUser])

 // 只加载项目已启用的工作项类型；团队级类型不能证明当前项目可用。
 useEffect(() => {
 if (!rv.project_uuid) return
 let canceled = false
 setLoadingTypes(true)
 setProjectTypesVerified(false)
 ;(async () => {
 const result = await resolveProjectIssueTypes(tu(), rv.project_uuid || '')
 if (canceled) return
 setIssueTypes(result.types)
 setProjectTypesVerified(result.verified)
 setCreateIssueForm(f => ({ ...f, project_uuid: result.project_uuid }))
 // 获取项目名称
 try {
 const stampRes = await fetch(
 `/project/api/project/team/${tu()}/project/${result.project_uuid}/stamps/data?t=project`,
 { method: 'POST', credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ project: 0 }),
 }
 )
 if (stampRes.ok) {
 const sdata = await stampRes.json()
 const stampRaw = sdata?.data || sdata || {}
 const proj = stampRaw?.project?.projects?.[0]
 if (proj?.name) setProjectDisplayName(proj.name)
 }
 } catch {}
 setLoadingTypes(false)
 })()
 return () => { canceled = true }
 }, [rv.project_uuid])

 useEffect(() => {
 if (loadingTypes || !projectTypesVerified) return
 const selectedType = findConfiguredIssueType(issueTypes, remediationIssueType, remediationIssueTypeUuid)
   || ((!remediationIssueType && !remediationIssueTypeUuid) ? issueTypes[0] : undefined)
 if (!selectedType) return
 setCreateIssueForm(f => ({
   ...f,
   issue_type_scope_uuid: selectedType.scope_uuid,
   issue_type_id: selectedType.issue_type_uuid,
 }))
 }, [loadingTypes, projectTypesVerified, issueTypes, remediationIssueType, remediationIssueTypeUuid])

 async function resolveCreationIssueType() {
 const result = await resolveProjectIssueTypes(tu(), createIssueForm.project_uuid || rv.project_uuid || '')
 setIssueTypes(result.types)
 setProjectTypesVerified(result.verified)
 if (!result.verified) throw new Error('无法确认当前项目的工作项类型，不允许新建整改项。请刷新后重试。')
 const configured = findConfiguredIssueType(result.types, remediationIssueType, remediationIssueTypeUuid)
 if ((remediationIssueType || remediationIssueTypeUuid) && !configured) {
   throw new Error(remediationTypeBlockedMessage('missing', remediationIssueType || remediationIssueTypeUuid))
 }
 const selected = configured || result.types.find(item =>
   item.scope_uuid === createIssueForm.issue_type_scope_uuid
   || item.issue_type_uuid === createIssueForm.issue_type_id)
 if (!selected) throw new Error('请选择当前项目已启用的工作项类型')
 return { projectUuid: result.project_uuid, issueType: selected }
 }

 async function submitOpinion() {
 if (!opinionForm.reviewer_uuid || !opinionForm.role_name || !opinionForm.conclusion) {
 setOpinionMsg('请完善评审信息'); return
 }
 if (opinionForm.conclusion !== 'pass' && !opinionForm.opinion_summary.trim()) {
 setOpinionMsg('结论为「有条件通过」或「不通过」时，必须填写评审意见'); return
 }
 // Checklist 前端预检：当前角色所有项必须已勾选
 {
   const myChecklistItems = (data.checklist || []).filter((c: any) => c.role_name === myRole)
   if (myChecklistItems.length > 0) {
     const unchecked = myChecklistItems.filter((c: any) => !c.status || c.status === 'unchecked')
     if (unchecked.length > 0) {
       const names = unchecked.map((c: any) => c.item_text || c.template_id).join('、')
       setOpinionMsg(`请先完成所有 Checklist 勾选后再提交，未勾选：${names}`); return
     }
   }
 }
 setOpinionMsg('')
 setSubmittingOpinion(true)
 try {
 await callApi(`/dcp/review/${rv.review_uuid}/opinion`, 'POST', opinionForm)
 setOpinionToast('评审意见已提交')
 setTimeout(() => setOpinionToast(''), 3000)
 onRefresh()
 } catch (e: any) { setOpinionMsg(e.message) }
 finally { setSubmittingOpinion(false) }
 }

 // 同步整改项状态：浏览器 GraphQL 查询工作项实时状态 → 调后端 sync API 更新实体存储
 async function syncRemediationFromBrowser(): Promise<boolean> {
 const remediationIssues = (data.remediation_issues || []).filter((iss: any) => iss.link_type === 'remediation')
 if (remediationIssues.length === 0 || !teamUUID) return false
 const remUuids = remediationIssues.map((iss: any) => iss.issue_uuid).filter(Boolean)
 if (remUuids.length === 0) return false
 const syncItems: any[] = []
 try {
 const gqlRes = await fetch(`/project/api/project/team/${teamUUID}/items/graphql`, {
 method: 'POST', credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 query: `query findTasks($filter: TasksFilter) { tasks(filter: $filter) { uuid status { uuid name category } } }`,
 variables: { filter: { uuid_in: remUuids } },
 }),
 })
 if (gqlRes.ok) {
 const gqlData = await gqlRes.json()
 const tasks = gqlData?.data?.tasks || []
 for (const task of tasks) {
 const statusName = task?.status?.name || ''
 const statusId = task?.status?.uuid || ''
 const category = task?.status?.category
 if (statusName) syncItems.push({ issue_uuid: task.uuid, status_name: statusName, status_id: statusId, category })
 }
 }
 } catch {}
 if (syncItems.length === 0) return false
 await callApi(`/dcp/review/${rv.review_uuid}/remediation/sync`, 'POST', { items: syncItems })
 return true
 }

 // 进入评审单时自动同步整改项状态
 useEffect(() => {
 syncRemediationFromBrowser().then((synced) => { if (synced) onRefresh() }).catch(() => {})
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [rv.review_uuid])

 async function handlePublishResolution() {
 if (!resolutionForm.final_conclusion) {
 setResolutionMsg('请选择决议结果'); return
 }
 if ((resolutionForm.final_conclusion === 'conditional_pass' || resolutionForm.final_conclusion === 'rework') && !resolutionForm.condition_notes.trim()) {
 setResolutionMsg('结论为「有条件通过」或「返工」时，必须填写条件说明'); return
 }
 setResolving(true)
 setResolutionMsg('')
 try {
 // 发布决议前先同步整改项状态，确保快照记录的状态是最新的
 await syncRemediationFromBrowser()
 await callApi(`/dcp/review/${rv.review_uuid}/publish-resolution`, 'POST', {
 final_conclusion: resolutionForm.final_conclusion,
 condition_notes: resolutionForm.condition_notes,
 publisher_uuid: currentUser.uuid || '',
 publisher_name: currentUser.name || '',
 })
 onRefresh()
 } catch (e: any) { setResolutionMsg(e.message || '发布失败') }
 finally { setResolving(false) }
 }

 const teamUUID = getTeamUUID()
 function taskUrl(iss: any) {
 const num = iss.issue_number || iss.issue_uuid
 return `/project/#/team/${teamUUID}/project/${rv.project_uuid}/issue/${num}`
 }

 function downloadMaterial(templateId: string) {
 callApi(`/dcp/review/${rv.review_uuid}/material/${templateId}/download-url`).then((r: any) => {
 if (!r.url) return
 // 用隐藏 <a download> 在当前窗口触发下载，不开新标签
 const a = document.createElement('a')
 a.href = r.url
 a.download = r.file_name || ''
 a.style.display = 'none'
 document.body.appendChild(a)
 a.click()
 document.body.removeChild(a)
 }).catch(() => {})
 }

 function downloadAttachment(objectKey: string) {
 callApi(`/dcp/review/${rv.review_uuid}/material-attachment/download-url?object_key=${encodeURIComponent(objectKey)}`).then((r: any) => {
 if (!r.url) return
 const a = document.createElement('a')
 a.href = r.url
 a.download = r.file_name || ''
 a.style.display = 'none'
 document.body.appendChild(a)
 a.click()
 document.body.removeChild(a)
 }).catch(() => {})
 }

 async function previewAttachment(objectKey: string, fileName: string) {
 setPreviewLoading(true)
 try {
 const r: any = await callApi(`/dcp/review/${rv.review_uuid}/material-attachment/preview?object_key=${encodeURIComponent(objectKey)}&file_name=${encodeURIComponent(fileName)}`)
 if (r.content) {
 const previewable = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml', 'text/plain', 'text/csv']
 if (previewable.includes(r.mime)) {
 const dataUrl = `data:${r.mime};base64,${r.content}`
 setPreview({ url: dataUrl, name: fileName })
 } else {
 setPreview({ url: `__unsupported__`, name: fileName })
 }
 }
 } catch { /* ignore */ }
 finally { setPreviewLoading(false) }
 }

 async function previewMaterial(templateId: string, fileName: string) {
 setPreviewLoading(true)
 try {
 const r: any = await callApi(`/dcp/review/${rv.review_uuid}/material/${templateId}/preview`)
 if (r.content) {
 const previewable = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml', 'text/plain', 'text/csv']
 if (previewable.includes(r.mime)) {
 const dataUrl = `data:${r.mime};base64,${r.content}`
 setPreview({ url: dataUrl, name: fileName })
 } else {
 setPreview({ url: `__unsupported__`, name: fileName })
 }
 }
 } catch { /* ignore */ }
 finally { setPreviewLoading(false) }
 }

 // 调用 exchange API 解析项目标识符为真实 UUID
 async function resolveAndOpenCreateIssue() {
 if (remediationCreationBlocked) {
   setCreateIssueMsg(remediationTypeMessage || '正在确认当前项目的工作项类型，请稍后重试。')
   return
 }
 setResolvingProject(true)
 try {
 const result = await resolveProjectIssueTypes(tu(), rv.project_uuid || '')
 if (!result.verified) throw new Error('无法确认当前项目的工作项类型，不允许新建整改项。请刷新后重试。')
 if ((remediationIssueType || remediationIssueTypeUuid)
   && !findConfiguredIssueType(result.types, remediationIssueType, remediationIssueTypeUuid)) {
   throw new Error(remediationTypeBlockedMessage('missing', remediationIssueType || remediationIssueTypeUuid))
 }
 window.parent.location.href = `${window.parent.location.origin}/project/#/team/${tu()}/project/${result.project_uuid}/task/create`
 } catch (e: any) {
 setCreateIssueMsg(e.message || '无法打开 ONES 新建页面')
 }
 setResolvingProject(false)
 }

 // 创建工作项：前端浏览器直调 tasks/add3（用 scope_uuid），后端只负责关联
 async function handleCreateIssue() {
 if (!createIssueForm.title || !createIssueForm.project_uuid) {
 setCreateIssueMsg('请填写标题和项目')
 return
 }
 if (!createIssueForm.assignee_uuid) {
 setCreateIssueMsg('请选择负责人')
 return
 }
 setCreating(true)
 setCreateIssueMsg('')
 setCreateIssueFallback('')

 let resolvedType: Awaited<ReturnType<typeof resolveCreationIssueType>>
 try {
   resolvedType = await resolveCreationIssueType()
 } catch (e: any) {
   setCreateIssueMsg(e.message || '当前项目的整改工作项类型不可用')
   setCreating(false)
   return
 }
 const scopeUuid = resolvedType.issueType.scope_uuid
 const typeUuid = resolvedType.issueType.issue_type_uuid
 const realProjectUuid = resolvedType.projectUuid

 try {
 // 方式一：前端 fetch 直调 tasks/add3
 // 成功 HAR 证实：issue_type_uuid 和 field007 应使用全局 work item type UUID
 // ONES 要求 task uuid 为 16 位字母数字
 const taskUuid = Array.from({length: 16}, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('')
 const add3Res = await fetch(`/project/api/project/team/${tu()}/tasks/add3`, {
 method: 'POST', credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 tasks: [{
 uuid: taskUuid,
 project_uuid: realProjectUuid,
 issue_type_uuid: typeUuid || undefined,
 field_values: [
 { field_uuid: 'field001', value: createIssueForm.title },
 { field_uuid: 'field006', value: realProjectUuid },
 { field_uuid: 'field007', value: typeUuid },
 { field_uuid: 'field004', value: createIssueForm.assignee_uuid },
 ],
 }],
 }),
 })

 if (add3Res.ok) {
 const data = await add3Res.json()
 const task = data?.tasks?.[0]
 if (task?.uuid) {
 // 关联到评审单（后端操作），用 tasks/add3 返回的 issue_type_name
 try {
 await callApi(`/dcp/review/${rv.review_uuid}/link-issue`, 'POST', {
 issue_uuid: task.uuid,
 issue_number: task.display_id || task.uuid,
 issue_title: createIssueForm.title,
 issue_type: task.issue_type_name || resolvedType.issueType.name,
 issue_status: '',
 linked_by: currentUser.uuid || '',
 linked_by_name: currentUser.name || '',
 link_type: 'remediation',
 })
 } catch (linkError: any) {
 setCreateIssueMsg(`工作项 ${task.display_id || task.uuid} 已创建，但关联评审单失败：${linkError.message || '未知错误'}`)
 onRefresh()
 setCreating(false)
 return
 }
 const resetType = (remediationIssueType || remediationIssueTypeUuid) ? resolvedType.issueType : (issueTypes[0] || resolvedType.issueType)
 setCreateIssueForm({
 title: '',
 issue_type_scope_uuid: resetType.scope_uuid || '',
 issue_type_id: resetType.issue_type_uuid || '',
 project_uuid: realProjectUuid,
 assignee_uuid: currentUser.uuid || '',
 })
 setCreateIssueMsg(`创建工作项成功: ${task.display_id || task.uuid}`)
 onRefresh()
 setCreating(false)
 return
 }
 // HTTP 200 但 tasks 为空 → 检查 bad_tasks 中的错误
 if (data?.bad_tasks?.length > 0) {
 const bt = data.bad_tasks[0]
 const permMsg = bt.errcode || bt.type || bt.code || '创建失败'
 setCreateIssueMsg(`创建失败: ${permMsg}${bt.permission ? `（${bt.permission}）` : ''}`)
 setCreating(false)
 return
 }
 }

 // tasks/add3 返回了非预期格式，尝试解析
 const add3Text = await add3Res.text()
 throw new Error(`tasks/add3 返回异常: ${add3Res.status} ${add3Text.slice(0, 200)}`)
 } catch (e: any) {
 // 回退：后端 createIssue（会尝试多条内部路径，失败返回 fallback_url）
 try {
 await callApi(`/dcp/review/${rv.review_uuid}/create-issue`, 'POST', {
   title: createIssueForm.title,
   project_uuid: realProjectUuid,
   issue_type_scope_uuid: scopeUuid,
   issue_type_uuid: typeUuid,
   assignee_uuid: createIssueForm.assignee_uuid || currentUser.uuid || '',
   linked_by: currentUser.uuid || '',
   linked_by_name: currentUser.name || '',
   ones_origin: window.location.origin,
 })
 const resetType = (remediationIssueType || remediationIssueTypeUuid) ? resolvedType.issueType : (issueTypes[0] || resolvedType.issueType)
 setCreateIssueForm({
 title: '',
 issue_type_scope_uuid: resetType.scope_uuid || '',
 issue_type_id: resetType.issue_type_uuid || '',
 project_uuid: realProjectUuid,
 assignee_uuid: currentUser.uuid || '',
 })
 onRefresh()
 } catch (e2: any) {
 const errData = e2?.data || e2 || {}
 if (errData.fallback_url) {
 setCreateIssueFallback(errData.fallback_url)
 setCreateIssueMsg('ONES 内部 API 不可用，请在下方跳转原生页面创建')
 } else {
 setCreateIssueMsg(errData?.error || e2.message || e.message || '创建失败')
 }
 }
 }
 setCreating(false)
 }

 return (
 <div style={S.container}>
 <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
 <button style={S.btn(false)} onClick={onBack}>← 返回列表</button>
 {directLink && <button style={{ ...S.btn(false), borderColor: '#1677ff', color: '#1677ff' }} onClick={() => { window.parent.location.href = '/project/' }}>← 返回 ONES 主界面</button>}
 </div>

 {/* 头部 */}
 <div style={{ ...S.card, background: '#f0f5ff' }}>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
 <div>
 <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#1677ff', fontWeight: 600, marginRight: 8, cursor: 'pointer' }} title="点击复制编号" onClick={() => handleCopyReviewLink(rv.review_number || rv.review_uuid)}>{rv.review_number || ''}</span>
 <strong style={{ fontSize: 16 }}>{rv.phase_name || rv.phase_code} — {rv.review_title || 'DCP评审'}</strong>
 </div>
 <div style={{ fontSize: 12, color: '#666' }}>
 项目: {projectDisplayName} | 创建: {rv.created_at ? new Date(rv.created_at).toLocaleString('zh-CN') : '-'}
 </div>
 </div>
 </div>

 {/* 材料 — 只读 */}
 <div style={S.card}>
 <h4 style={S.sectionTitle}>评审资料（已上传 {mats.filter((m: any) => !!m.file_data).length}/{mats.length}）</h4>
 <table style={S.table}>
 <thead><tr>
 <th style={S.th}>材料名称</th>
 <th style={S.th}>附件</th>
 </tr></thead>
 <tbody>
 {mats.length === 0 ? <tr><td colSpan={2} style={{ ...S.td, textAlign: 'center', color: '#999' }}>无</td></tr> :
 mats.map((m: any, i: number) => {
 const attachments = (m.attachments_json ? (typeof m.attachments_json === 'string' ? JSON.parse(m.attachments_json) : m.attachments_json) : []) as any[]
 const isRemediated = attachments.length > 0
 return (
 <tr key={i}>
 <td style={S.td}>{m.template?.required ? <span style={{ color: '#ff4d4f', marginRight: 4 }}>*</span> : ''}{m.template?.material_name || m.template_id}{isRemediated && <span style={{ fontSize: 10, color: '#fa8c16', marginLeft: 4, border: '1px solid #fa8c16', borderRadius: 3, padding: '0 4px' }}>已整改</span>}</td>
 <td style={S.td}>{m.file_name ? (
 <div>
 <span style={{ fontSize: 11, color: '#1677ff' }}>
 <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => previewMaterial(m.template_id, m.file_name)}>{m.file_name}</span>
 <button style={{ fontSize: 10, padding: '1px 6px', border: '1px solid #52c41a', borderRadius: 3, background: '#fff', color: '#52c41a', cursor: 'pointer', marginLeft: 4 }} onClick={() => downloadMaterial(m.template_id)}>下载</button>
 </span>
 {isRemediated && (
 <div style={{ marginTop: 4, paddingLeft: 12, borderLeft: '2px solid #fa8c16' }}>
 {attachments.map((att: any, ai: number) => (
 <div key={ai} style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>
 <span style={{ color: '#fa8c16', marginRight: 4 }}>原版:</span>
 <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => previewAttachment(att.file_data, att.file_name)}>{att.file_name}</span>
 <button style={{ fontSize: 10, padding: '1px 6px', border: '1px solid #d9d9d9', borderRadius: 3, background: '#fff', color: '#666', cursor: 'pointer', marginLeft: 4 }} onClick={() => downloadAttachment(att.file_data)}>下载</button>
 </div>
 ))}
 </div>
 )}
 </div>
 ) : <span style={{ color: '#999', fontSize: 11 }}>—</span>}</td>
 </tr>
 )
 })}
 </tbody>
 </table>
 </div>

 {/* 指标 — 只读 */}
 <div style={S.card}>
 <h4 style={S.sectionTitle}>关键指标（{inds.length}项）</h4>
 <table style={S.table}>
 <thead><tr>
 <th style={S.th}>指标</th><th style={S.th}>单位</th><th style={{ ...S.th, width: 60, textAlign: 'center' }}>黄</th><th style={{ ...S.th, width: 60, textAlign: 'center' }}>红</th>
 <th style={{ ...S.th, width: 90, textAlign: 'center' }}>当前值</th><th style={{ ...S.th, width: 60, textAlign: 'center' }}>风险</th>
 </tr></thead>
 <tbody>
 {inds.length === 0 ? <tr><td colSpan={6} style={{ ...S.td, textAlign: 'center', color: '#999' }}>无</td></tr> :
 inds.map((ind: any, i: number) => {
 const tpl = ind.template
 const riskBg = ind.risk_color === 'red' ? '#fff1f0' : ind.risk_color === 'yellow' ? '#fff7e6' : '#f6ffed'
 const riskText = ind.risk_color === 'red' ? '🔴 红' : ind.risk_color === 'yellow' ? '🟡 黄' : '🟢 绿'
 return (
 <tr key={i} style={{ background: riskBg }}>
 <td style={S.td}>{tpl?.indicator_name || ind.template_id}</td>
 <td style={S.td}>{tpl?.unit || '-'}</td>
 <td style={{ ...S.td, textAlign: 'center' }}>{tpl?.yellow_threshold ?? '-'}</td>
 <td style={{ ...S.td, textAlign: 'center' }}>{tpl?.red_threshold ?? '-'}</td>
 <td style={{ ...S.td, textAlign: 'center', fontWeight: 600 }}>{ind.current_value} {tpl?.unit}</td>
 <td style={{ ...S.td, textAlign: 'center', fontSize: 12 }}>{riskText}</td>
 </tr>
 )
 })}
 </tbody>
 </table>
 </div>

 {/* Checklist */}
 <ChecklistPanel
  checklist={data.checklist || []}
  currentUser={currentUser}
  myRole={myRole}
  isPublisher={canPublish}
  reviewUuid={rv.review_uuid}
  status={rv.effective_state || rv.review_state || rv.status}
  alreadySubmitted={alreadySubmitted}
  onRefresh={onRefresh}
 />

 {/* 评审意见 — 决议模式下不展示，决议人无需填写普通评审意见 */}

{/* 整改工作项 */}
 <div style={S.card}>
 <h4 style={S.sectionTitle}>{canPublish ? '整改项' : '我的整改项'}（{(canPublish ? allIssues : myIssues).length}个）</h4>
 {!canPublish && allIssues.length > myIssues.length && <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>（共 {allIssues.length} 个关联工作项，仅显示你创建的 {myIssues.length} 个）</div>}
 {(canPublish ? allIssues : myIssues).length === 0 ? <div style={{ color: '#999', padding: 12, textAlign: 'center', fontSize: 13 }}>{canPublish ? '暂无整改项' : (allIssues.length > 0 ? '其他评审人已创建工作项，你尚未创建' : '暂无关联工作项')}</div> :
 <table style={S.table}>
 <thead><tr>
 <th style={{ ...S.th, width: 100 }}>ID</th><th style={S.th}>标题</th><th style={{ ...S.th, width: 110 }}>工作项类型</th><th style={{ ...S.th, width: 80 }}>状态</th><th style={{ ...S.th, width: 80 }}>创建者</th>
 </tr></thead>
 <tbody>
 {(canPublish ? allIssues : myIssues).map((iss: any, i: number) => (
 <tr key={i}>
 <td style={S.td}><a href={taskUrl(iss)} target="_blank" style={{ color: '#1677ff', textDecoration: 'none', fontFamily: 'monospace', fontSize: 11 }}>{iss.issue_number || iss.issue_uuid?.substring(0, 12)}</a></td>
 <td style={S.td}>{iss.issue_title || '-'}</td>
 <td style={S.td}>{iss.issue_type || '-'}</td>
 <td style={S.td}>{iss.issue_status || '-'}</td>
 <td style={S.td}>{iss.linked_by_name || (iss.linked_by ? iss.linked_by.substring(0, 8) : '-')}</td>
 </tr>
 ))}
 </tbody>
 </table>}
 <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
 {alreadySubmitted && !canPublish ? (
   <div style={{ padding: '12px', textAlign: 'center', fontSize: 13, color: '#999' }}>
     已提交评审意见，不可再创建整改项
   </div>
 ) : (
 <>
 <h4 style={{ ...S.sectionTitle, fontSize: 13 }}>+ 创建整改项</h4>
 {remediationTypeMessage && (
   <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 4, fontSize: 12, background: '#fff2f0', color: '#cf1322', border: '1px solid #ffccc7' }}>
     {remediationTypeMessage}
   </div>
 )}
 {createIssueMsg && <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: createIssueFallback ? '#fff7e6' : '#fff2f0', color: createIssueFallback ? '#faad14' : '#cf1322' }}>{createIssueMsg}
 {createIssueFallback && (
 <div style={{ marginTop: 8 }}>
 <a href="#" onClick={e => {
 e.preventDefault()
 try { window.parent.location.href = window.parent.location.origin + '/' + createIssueFallback } catch {}
 }} style={{ display: 'inline-block', padding: '6px 16px', borderRadius: 4, background: '#1677ff', color: '#fff', textDecoration: 'none', fontSize: 13 }}>
 跳转到 ONES 原生创建页面
 </a>
 </div>
 )}
 </div>}
 <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
 <div style={S.formGroup}>
 <label style={S.label}>标题 *</label>
 <input style={{ ...S.input, width: 200 }} value={createIssueForm.title} onChange={e => setCreateIssueForm({ ...createIssueForm, title: e.target.value })} placeholder="工作项标题" disabled={remediationCreationBlocked} />
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>类型{remediationIssueType ? '' : ''}</label>
 {loadingTypes ? <span style={{ fontSize: 12, color: '#999' }}>加载中…</span> :
 (remediationIssueType || remediationIssueTypeUuid) ? (
   // 配置了整改项类型：锁定显示，不可修改
   <input style={{ ...S.input, background: '#f5f5f5', color: '#666' }} value={remediationIssueType || remediationIssueTypeUuid} disabled />
 ) : (
   // 未配置：允许选择
   <SearchableTypePicker
     types={issueTypes}
     value={createIssueForm.issue_type_scope_uuid}
     onChange={(scopeUuid, issueTypeUuid) => setCreateIssueForm({
       ...createIssueForm, issue_type_scope_uuid: scopeUuid, issue_type_id: issueTypeUuid,
     })}
   />
 )
 }
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>项目 *</label>
 <input style={{ ...S.input, background: '#f5f5f5', color: '#666' }} value={projectDisplayName} disabled placeholder="当前项目" />
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>负责人 *</label>
 <UserPicker value={createIssueForm.assignee_uuid} onChange={u => setCreateIssueForm({ ...createIssueForm, assignee_uuid: u.uuid })} placeholder="搜索用户…（必填）" />
 </div>
 <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
 <button style={{ ...S.btn(true), marginBottom: 0 }} onClick={handleCreateIssue} disabled={creating || remediationCreationBlocked}>
 {creating ? '创建中…' : '创建整改项'}
 </button>
 <button style={{ ...S.btn(false), marginBottom: 0 }} onClick={resolveAndOpenCreateIssue} disabled={resolvingProject || remediationCreationBlocked}>
 {resolvingProject ? '解析中…' : '跳转ONES手动创建'}
 </button>
 </div>
 </div>
 </>
 )}
 </div>
 </div>

{!isResolutionMode && (
 <div style={{ ...S.card, background: alreadySubmitted ? '#f6ffed' : '#f0f5ff', borderLeft: `4px solid ${alreadySubmitted ? '#52c41a' : '#1677ff'}` }}>
 <h4 style={S.sectionTitle}>{alreadySubmitted ? '评审意见（已提交）' : '我的评审意见'}</h4>
 {_isReReviewing && !alreadySubmitted && (
   <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#e6f4ff', color: '#1677ff', border: '1px solid #91caff' }}>
     第 {_wsRoundNo} 轮复审{_prevResolution ? `（上一轮决议：${_prevResolution.final_conclusion === 'conditional_pass' ? '有条件通过' : _prevResolution.final_conclusion === 'rework' ? '返工' : _prevResolution.final_conclusion}）` : ''}。整改项已完成，请重新评估并提交评审意见。
   </div>
 )}
 {opinionMsg && <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#cf1322' }}>{opinionMsg}</div>}
 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
 <div style={S.formGroup}>
 <label style={S.label}>评审人</label>
 <input style={{ ...S.input, background: '#f5f5f5', color: '#666' }} value={currentUser.name || currentUser.uuid || '（未识别）'} readOnly />
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>评审角色</label>
 <input style={{ ...S.input, background: '#f5f5f5', color: '#666' }} value={myRole || '（未匹配评审角色）'} readOnly />
 </div>
 </div>
 {alreadySubmitted ? (
 <div style={{ marginTop: 12 }}>
 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
 <div style={S.formGroup}>
 <label style={S.label}>结论</label>
 <input style={{ ...S.input, background: '#f5f5f5', color: '#333' }} value={opinionForm.conclusion === 'pass' ? '✅ 通过' : opinionForm.conclusion === 'conditional_pass' ? '⚠️ 有条件通过' : '❌ 不通过'} readOnly />
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>风险等级</label>
 <input style={{ ...S.input, background: '#f5f5f5', color: '#333' }} value={opinionForm.risk_level === 'low' ? '低' : opinionForm.risk_level === 'medium' ? '中' : '高'} readOnly />
 </div>
 </div>
 <div style={{ ...S.formGroup, marginTop: 8 }}>
 <label style={S.label}>意见摘要</label>
 <div style={{ padding: '6px 10px', background: '#fafafa', borderRadius: 4, fontSize: 13, minHeight: 40, border: '1px solid #e8e8e8', whiteSpace: 'pre-wrap' }}>
 {opinionForm.opinion_summary || '（无）'}
 </div>
 </div>
 <div style={{ marginTop: 8, fontSize: 12, color: '#52c41a' }}>
 提交时间: {myReviewer?.submitted_at ? new Date(myReviewer.submitted_at).toLocaleString('zh-CN') : ''}
 </div>
 </div>
 ) : (
 <>
 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
 <div style={S.formGroup}>
 <label style={S.label}>结论 *</label>
 <select style={{ ...S.select, width: '100%' }} value={opinionForm.conclusion} onChange={e => setOpinionForm({ ...opinionForm, conclusion: e.target.value })}>
 <option value="" disabled>请选择</option><option value="pass">✅ 通过</option><option value="conditional_pass">⚠️ 有条件通过</option><option value="fail">❌ 不通过</option>
 </select>
 </div>
 <div style={S.formGroup}>
 <label style={S.label}>风险等级</label>
 <select style={{ ...S.select, width: '100%' }} value={opinionForm.risk_level} onChange={e => setOpinionForm({ ...opinionForm, risk_level: e.target.value })}>
 <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
 </select>
 </div>
 </div>
 <div style={{ ...S.formGroup, marginTop: 8 }}>
   <label style={S.label}>意见摘要</label>
   <textarea style={S.textarea} rows={4} value={opinionForm.opinion_summary} onChange={e => setOpinionForm({ ...opinionForm, opinion_summary: e.target.value })} placeholder="输入评审意见摘要…" />
 </div>
 {opinionForm.conclusion === 'conditional_pass' && (
   <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 4, fontSize: 12, background: '#fff7e6', color: '#fa8c16', border: '1px solid #faad14' }}>
     选择「有条件通过」时，必须先在下方创建至少 1 个整改项后再提交。
     {myIssues.some((iss: any) => iss.link_type === 'remediation')
       ? <span style={{ color: '#52c41a' }}> 已创建整改项。</span>
       : <span style={{ color: '#ff4d4f' }}> 当前无整改项，请先创建。</span>}
   </div>
 )}
 {opinionToast && <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#f6ffed', color: '#52c41a', border: '1px solid #b7eb8f' }}>{opinionToast}</div>}
 <button style={{ ...S.btn(true), marginTop: 8 }} onClick={submitOpinion} disabled={submittingOpinion}>{submittingOpinion ? '提交中…' : '提交评审意见'}</button>
 </>
 )}
</div>
)}

{/* 评审意见汇总 */}
{(isResolutionMode || canPublish) && reviewers.length > 0 && (
  <div style={S.card}>
    <h4 style={S.sectionTitle}>评审意见汇总</h4>
    <div style={S.tableWrap}>
    <table style={S.table}>
    <thead><tr>
    <th style={S.th}>角色</th><th style={S.th}>投票</th><th style={S.th}>风险</th><th style={S.th}>意见</th>
    </tr></thead>
    <tbody>
    {reviewers.map((v: any, i: number) => (
    <tr key={i}>
    <td style={S.td}>{v.role_name}</td>
    <td style={S.td}>
    <span style={{ color: v.conclusion === 'pass' ? '#52c41a' : v.conclusion === 'conditional_pass' ? '#faad14' : '#ff4d4f' }}>
    {v.conclusion === 'pass' ? '✅ 通过' : v.conclusion === 'conditional_pass' ? '⚠️ 有条件通过' : v.submitted_at > 0 ? '❌ 不通过' : '— 未投票'}
    </span>
    </td>
    <td style={S.td}>{v.risk_level === 'low' ? '低' : v.risk_level === 'high' ? '高' : '中'}</td>
    <td style={{ ...S.td, fontSize: 12, color: '#666', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.opinion_summary || '-'}</td>
    </tr>
    ))}
    </tbody>
    </table>
    </div>
  </div>
)}

{/* 决议（发布人可见）— 仅决议人/决议模式可见 */}
{(() => {
if (!canPublish && !isResolutionMode) return null
const res = data.resolution
 const votes: any[] = res?.based_on_votes ? (() => { try { return JSON.parse(res.based_on_votes) } catch { return [] } })() : []

 if (res) {
 // 已发布：展示决议
 return (
 <div style={{ ...S.card, background: '#f6ffed', borderLeft: '4px solid #52c41a' }}>
 <h4 style={S.sectionTitle}>决议快照 {res.snapshot_number ? `(${res.snapshot_number})` : ''}</h4>
 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
 <div style={S.formGroup}>
 <label style={S.label}>最终结论</label>
 <span style={{ fontSize: 14, fontWeight: 600, color: res.final_conclusion === 'pass' ? '#52c41a' : res.final_conclusion === 'conditional_pass' ? '#faad14' : '#ff4d4f' }}>
 {res.final_conclusion === 'pass' ? '✅ 通过' : res.final_conclusion === 'conditional_pass' ? '⚠️ 有条件通过' : '❌ 驳回'}
 </span>
 </div>

 <div style={S.formGroup}>

 <label style={S.label}>发布人</label>
 <span style={{ fontSize: 13 }}>{res.published_by_name || res.published_by || '-'}</span>
 </div>
 </div>
 {res.condition_notes && (
 <div style={{ marginBottom: 12 }}>
 <label style={S.label}>条件说明</label>
 <div style={{ padding: '6px 10px', background: '#fafafa', borderRadius: 4, fontSize: 13, border: '1px solid #e8e8e8', whiteSpace: 'pre-wrap' }}>{res.condition_notes}</div>
 </div>
 )}
 {/* 决议模式下也展示评审人意见汇总（实时数据，非快照） */}
 {(isResolutionMode || votes.length > 0) && (
 <div>
 <label style={S.label}>{votes.length > 0 ? '评审意见汇总（投票快照）' : '评审意见汇总'}</label>
 <div style={S.tableWrap}>
 <table style={S.table}>
 <thead><tr>
 <th style={S.th}>角色</th><th style={S.th}>投票</th><th style={S.th}>风险</th><th style={S.th}>意见</th>
 </tr></thead>
 <tbody>
 {(votes.length > 0 ? votes : reviewers).map((v: any, i: number) => (
 <tr key={i}>
 <td style={S.td}>{v.role_name}</td>
 <td style={S.td}>
 <span style={{ color: v.conclusion === 'pass' ? '#52c41a' : v.conclusion === 'conditional_pass' ? '#faad14' : '#ff4d4f' }}>
 {v.conclusion === 'pass' ? '✅ 通过' : v.conclusion === 'conditional_pass' ? '⚠️ 有条件通过' : v.submitted_at > 0 ? '❌ 不通过' : '— 未投票'}
 </span>
 </td>
 <td style={S.td}>{v.risk_level === 'low' ? '低' : v.risk_level === 'high' ? '高' : '中'}</td>
 <td style={{ ...S.td, fontSize: 12, color: '#666', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.opinion_summary || '-'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
 发布时间: {res.published_at ? new Date(res.published_at).toLocaleString('zh-CN') : '-'}
 </div>
 </div>
 )
 }

 if (canPublishResolution) {
 // 待决议：展示发布表单
 return (
 <div style={{ ...S.card, background: '#fff7e6', borderLeft: '4px solid #faad14' }}>
 <h4 style={S.sectionTitle}>发布决议</h4>
 <div style={{ marginBottom: 8, fontSize: 13, color: '#333' }}>
   {(() => {
     const submitMode = resolutionRule?.submitRequirement?.mode || 'must_vote_roles'
     if (submitMode === 'publisher_only') return '可直接发布决议'
     if (submitMode === 'must_vote_roles') {
       const mustVoteNames = configRoles.filter((r: any) => r.must_vote).map((r: any) => r.role_name)
       const mustRvrs = reviewers.filter((r: any) => mustVoteNames.includes(r.role_name))
       const mustDone = mustRvrs.filter((r: any) => r.submitted_at > 0).length
       return `必投角色 ${mustDone}/${mustRvrs.length} 已提交，请发布最终决议。`
     }
     return `全部 ${reviewers.length} 名评审人已提交意见，请发布最终决议。`
   })()}
 </div>
 {(() => {
 const vsMode = resolutionRule?.passRule?.voteScope?.mode || 'must_vote_roles'
 const excludeRoles = resolutionRule?.passRule?.voteScope?.excludeRoles || []
 const selectedRoles = resolutionRule?.passRule?.voteScope?.selectedRoles || []
 const minCount = resolutionRule?.passRule?.minCount || 3
 const passMode = resolutionRule?.passRule?.mode || 'min_approval_count'
 const approvalConclusions = resolutionRule?.passRule?.approvalConclusions || ['pass', 'conditional_pass']
 if (passMode === 'min_approval_count') {
   let scopeNames: string[]
   if (vsMode === 'all_reviewers') scopeNames = configRoles.map((r: any) => r.role_name)
   else if (vsMode === 'selected_roles') scopeNames = configRoles.filter((r: any) => selectedRoles.includes(r.role_name)).map((r: any) => r.role_name)
   else scopeNames = configRoles.filter((r: any) => r.must_vote).map((r: any) => r.role_name)
   scopeNames = scopeNames.filter((n: string) => !excludeRoles.includes(n))
   const candidates = reviewers.filter((r: any) => scopeNames.includes(r.role_name))
   const acceptCount = candidates.filter((r: any) => approvalConclusions.includes(r.conclusion)).length
   if (candidates.length < minCount) {
     return (
     <div style={{ marginBottom: 8, padding: '6px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#ff4d4f' }}>
       可计票评审人仅 {candidates.length} 人，规则要求至少 {minCount} 人通过，请补充评审人或调整规则
     </div>
     )
   }
   const canPass = acceptCount >= minCount
   return (
   <div style={{ marginBottom: 8, padding: '6px 12px', borderRadius: 4, fontSize: 13, background: canPass ? '#f6ffed' : '#fff7e6', color: canPass ? '#52c41a' : '#faad14' }}>
   {canPass
   ? `同意票 ${acceptCount}/${candidates.length}，满足大多数（≥${minCount}），可决议为「通过」`
   : `同意票仅 ${acceptCount}/${candidates.length}，不满足大多数（需≥${minCount}）`}
   </div>
   )
 }
 const submitMode = resolutionRule?.submitRequirement?.mode || 'must_vote_roles'
 if (submitMode === 'publisher_only') return null
 if (submitMode === 'must_vote_roles') {
   const mustVoteNames = configRoles.filter((r: any) => r.must_vote).map((r: any) => r.role_name)
   const mustRvrs = reviewers.filter((r: any) => mustVoteNames.includes(r.role_name))
   const mustDone = mustRvrs.filter((r: any) => r.submitted_at > 0).length
   const allMustDone = mustDone >= mustRvrs.length
   return (
   <div style={{ marginBottom: 8, padding: '6px 12px', borderRadius: 4, fontSize: 13, background: allMustDone ? '#f6ffed' : '#fff7e6', color: allMustDone ? '#52c41a' : '#faad14' }}>
   {allMustDone
   ? `必投角色已全部提交（${mustDone}/${mustRvrs.length}），可发布决议`
   : `必投角色 ${mustDone}/${mustRvrs.length} 已提交，待必投角色全部提交后可发布决议`}
   </div>
   )
 }
 const doneCount = reviewers.filter((r: any) => r.submitted_at > 0).length
 return (
 <div style={{ marginBottom: 8, padding: '6px 12px', borderRadius: 4, fontSize: 13, background: '#f6ffed', color: '#52c41a' }}>
 评审进度 ${doneCount}/${reviewers.length}，可发布决议
 </div>
 )
 })()}
 {_isReReviewing && (
   <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#e6f4ff', color: '#1677ff', border: '1px solid #91caff' }}>
     第 {_wsRoundNo} 轮复审{_prevResolution ? `（上一轮决议：${_prevResolution.final_conclusion === 'conditional_pass' ? '有条件通过' : _prevResolution.final_conclusion === 'rework' ? '返工' : _prevResolution.final_conclusion}）` : ''}。请综合复审意见发布新决议。
   </div>
 )}
 {resolutionMsg && <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#cf1322' }}>{resolutionMsg}</div>}
 <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
 <div style={S.formGroup}>
 <label style={S.label}>最终结论 *</label>
 <select style={{ ...S.select, width: '100%' }} value={resolutionForm.final_conclusion} onChange={e => setResolutionForm({ ...resolutionForm, final_conclusion: e.target.value })}>
 <option value="" disabled>请选择结论</option>
 {(resolutionRule?.allowedConclusions || ['pass', 'conditional_pass', 'reject']).map((c: string) => {
 const labels: any = { pass: '✅ 通过', conditional_pass: '⚠️ 有条件通过', reject: '❌ 驳回', fail: '❌ 不通过', rework: '🔧 返工' }
 return <option key={c} value={c}>{labels[c] || c}</option>
 })}
 </select>
 </div>
 </div>
 <div style={{ ...S.formGroup, marginTop: 8 }}>
 <label style={S.label}>{(resolutionForm.final_conclusion === 'conditional_pass' || resolutionForm.final_conclusion === 'rework') ? '条件说明 *' : '条件说明'}</label>
 <textarea style={S.textarea} rows={3} value={resolutionForm.condition_notes} onChange={e => setResolutionForm({ ...resolutionForm, condition_notes: e.target.value })} placeholder={(resolutionForm.final_conclusion === 'conditional_pass' || resolutionForm.final_conclusion === 'rework') ? '请填写条件说明（必填）…' : "（可选）如为'有条件通过'，请说明条件…"} />
 {(resolutionForm.final_conclusion === 'conditional_pass' || resolutionForm.final_conclusion === 'rework') && (
   <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: '#e6f4ff', color: '#1677ff', border: '1px solid #91caff' }}>
     当前已有 {(data.remediation_issues || []).length} 个整改项，如不足可在上方整改项区域按需追加。
   </div>
 )}
 </div>

<button style={{ ...S.btn(true), marginTop: 12, background: '#faad14' }} onClick={handlePublishResolution} disabled={resolving}>
 {resolving ? '发布中…' : '发布决议'}
 </button>
 </div>
 )
 }

 // 非发布人或无决议需要：显示进度 + 评审人意见汇总
 return (
 <div style={{ ...S.card }}>
 <h4 style={S.sectionTitle}>决议状态</h4>
 <div style={{ fontSize: 13, color: '#666' }}>
 {(() => {
   const submitMode = resolutionRule?.submitRequirement?.mode || 'must_vote_roles'
   if (submitMode === 'publisher_only') {
     return canPublish ? '可直接发布决议' : '等待决议发布人发布决议'
   }
   if (submitMode === 'must_vote_roles') {
     const mustVoteNames = configRoles.filter((r: any) => r.must_vote).map((r: any) => r.role_name)
     const mustRvrs = reviewers.filter((r: any) => mustVoteNames.includes(r.role_name))
     const mustDone = mustRvrs.filter((r: any) => r.submitted_at > 0).length
     return canPublish
       ? `必投角色 ${mustDone}/${mustRvrs.length} 已提交（必投角色全部提交后即可发布决议）`
       : `必投角色 ${mustDone}/${mustRvrs.length} 已提交（必投角色全部提交后由决议发布人发布决议）`
   }
   const done = reviewers.filter((r: any) => r.submitted_at > 0).length
   return canPublish
     ? `评审进度: ${done}/${reviewers.length} 已提交（全部提交后即可发布决议）`
     : `评审进度: ${done}/${reviewers.length} 已提交（全部提交后由决议发布人发布决议）`
 })()}
</div>
</div>
 )
 })()}

{previewLoading && (
 <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
 <div style={{ background: '#fff', padding: '20px 32px', borderRadius: 8, fontSize: 14, color: '#666' }}>加载预览中…</div>
 </div>
 )}
 {preview && (
 <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', zIndex: 9999 }} onClick={() => setPreview(null)}>
 <div style={{ background: '#fff', margin: '24px', borderRadius: 8, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid #f0f0f0' }}>
 <strong style={{ fontSize: 14 }}>{preview.name}</strong>
 <button style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#999' }} onClick={() => setPreview(null)}>×</button>
 </div>
 {preview.url === '__unsupported__' ? (
 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
 <div style={{ fontSize: 48, marginBottom: 16 }}></div>
 <div style={{ fontSize: 14, marginBottom: 8 }}>该文件格式不支持在线预览</div>
 <div style={{ fontSize: 12, color: '#ccc' }}>{preview.name}</div>
 </div>
 ) : (
 <iframe src={preview.url} style={{ flex: 1, border: 'none', width: '100%' }} />
 )}
 </div>
 </div>
 )}
 {copyToast && (
 <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '8px 20px', borderRadius: 6, fontSize: 13, zIndex: 9999 }}>{copyToast}</div>
 )}
 </div>
 )
}

// ============================================================
// Checklist 面板
// ============================================================
const ChecklistPanel: React.FC<{
 checklist: any[]
 currentUser: { uuid: string; name: string }
 myRole: string
 isPublisher: boolean
 reviewUuid: string
 status: string
 alreadySubmitted: boolean
 onRefresh: () => void
}> = ({ checklist, currentUser, myRole, isPublisher, reviewUuid, status, alreadySubmitted, onRefresh }) => {
 const [errMsg, setErrMsg] = useState('')
 // 使用 effective_state 精确判断：仅 reviewing / re_reviewing 可勾选
 const _statusLower = (status || '').toLowerCase()
 const isDone = _statusLower !== 'reviewing' && _statusLower !== 're_reviewing'
 // 已提交评审意见后，checklist 也变为只读
 const isReadOnly = isDone || alreadySubmitted
 const [expandedRoles, setExpandedRoles] = useState<string[]>([])
 const [toggling, setToggling] = useState<string>('')

 if (checklist.length === 0) return null

 // 按角色分组
 const grouped: Record<string, any[]> = {}
 for (const c of checklist) {
 if (!grouped[c.role_name]) grouped[c.role_name] = []
 grouped[c.role_name].push(c)
 }

 // 统计达标率
 function stats(items: any[]) {
 const total = items.length
 const pass = items.filter((i: any) => i.status === 'pass').length
 return { pass, total }
 }

 async function toggleCheck(templateId: string, status: string) {
 setToggling(templateId)
 setErrMsg('')
 try {
 const resp = await fetch(
 `/project/api/project/team/${getTeamUUID()}/dcp/review/${reviewUuid}/checklist`,
 {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json', 'Ones-Plugin-Id': '709xehle' },
 body: JSON.stringify({ template_id: templateId, status, reviewer_uuid: currentUser.uuid }),
 }
 )
 const json = await resp.json()
 const data = json.body || json.data || json
 if (!resp.ok || data.error) throw new Error(data.error || `${resp.status}`)
 onRefresh()
 } catch (e: any) { setErrMsg(e.message || '勾选失败') }
 finally { setToggling('') }
 }

 function toggleExpand(role: string) {
 if (expandedRoles.includes(role)) setExpandedRoles(expandedRoles.filter(r => r !== role))
 else setExpandedRoles([...expandedRoles, role])
 }

 // 三态循环
 function nextStatus(current: string): string {
 if (current === 'pass') return 'fail'
 if (current === 'fail') return 'unchecked'
 return 'pass'
 }

 const statusDisplay: Record<string, string> = { unchecked: '☐', pass: '✅', fail: '❌' }
 const statusColor: Record<string, string> = { unchecked: '#999', pass: '#52c41a', fail: '#ff4d4f' }

 if (!isPublisher) {
 // 非发布角色：只看自己的
 const myItems = grouped[myRole] || []
 if (myItems.length === 0) return null
 const { pass, total } = stats(myItems)
 return (
 <div style={{ ...S.card, marginBottom: 16 }}>
 <h4 style={S.sectionTitle}>我的 Checklist <span style={{ fontSize: 12, fontWeight: 400, color: '#666', marginLeft: 8 }}>达标率: {pass}/{total}</span>{alreadySubmitted && <span style={{ fontSize: 12, fontWeight: 400, color: '#999', marginLeft: 8 }}>（已提交评审意见，不可修改）</span>}</h4>
 {errMsg && <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: '#fff2f0', color: '#cf1322' }}>{errMsg}</div>}
 {myItems.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((item: any) => {
 const s = item.status || 'unchecked'
 const isToggling = toggling === item.template_id
 return (
 <div key={item.template_id} style={{ display: 'flex', alignItems: 'center', padding: '4px 0', gap: 8, cursor: isReadOnly ? 'default' : 'pointer', opacity: isToggling ? 0.5 : 1 }}
 onClick={() => { if (!isReadOnly) toggleCheck(item.template_id, nextStatus(s)) }}>
 <span style={{ fontSize: 16, color: statusColor[s] }}>{statusDisplay[s]}</span>
 <span style={{ fontSize: 13, flex: 1 }}>{item.item_text}</span>
 </div>
 )
 })}
 </div>
 )
 }

 // 发布角色：全量折叠视图
 const roleNames = Object.keys(grouped)
 return (
 <div style={{ ...S.card, marginBottom: 16 }}>
 <h4 style={S.sectionTitle}>Checklist 总览</h4>
 {roleNames.map(rn => {
 const items = grouped[rn]
 const { pass, total } = stats(items)
 const expanded = expandedRoles.includes(rn)
 return (
 <div key={rn} style={{ marginBottom: 8 }}>
 <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: '#f9f9f9', borderRadius: 4, cursor: 'pointer', fontWeight: 500, fontSize: 13 }}
 onClick={() => toggleExpand(rn)}>
 <span>{expanded ? '▾' : '▸'}</span>
 <span>{rn}</span>
 <span style={{ fontSize: 12, color: pass === total ? '#52c41a' : '#faad14', marginLeft: 'auto' }}>{pass}/{total} </span>
 </div>
 {expanded && items.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((item: any) => {
 const s = item.status || 'unchecked'
 return (
 <div key={item.template_id} style={{ display: 'flex', alignItems: 'center', padding: '3px 0 3px 20px', gap: 8, fontSize: 12 }}>
 <span style={{ color: statusColor[s], fontSize: 14 }}>{statusDisplay[s]}</span>
 <span>{item.item_text}</span>
 </div>
 )
 })}
 </div>
 )
 })}
 </div>
 )
}

// ============================================================
// 内嵌 Checklist（发布决议时查看详情，只读可展开）
// ============================================================
const ChecklistInline: React.FC<{ checklist: any[] }> = ({ checklist }) => {
 const [expanded, setExpanded] = useState<Record<string, boolean>>({})

 // 按角色分组
 const grouped: Record<string, any[]> = {}
 for (const c of checklist) {
 if (!grouped[c.role_name]) grouped[c.role_name] = []
 grouped[c.role_name].push(c)
 }

 const statusDisplay: Record<string, string> = { unchecked: '☐', pass: '✅', fail: '❌' }
 const statusColor: Record<string, string> = { unchecked: '#999', pass: '#52c41a', fail: '#ff4d4f' }

 return (
 <div style={{ marginTop: 12 }}>
 <label style={S.label}>Checklist 详情</label>
 {Object.keys(grouped).map(rn => {
 const items = grouped[rn]
 const pass = items.filter((i: any) => i.status === 'pass').length
 const total = items.length
 const isExpanded = expanded[rn] || false
 return (
 <div key={rn} style={{ marginBottom: 4 }}>
 <div
 style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: '#f5f5f5', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 500 }}
 onClick={() => setExpanded({ ...expanded, [rn]: !isExpanded })}
 >
 <span>{isExpanded ? '▾' : '▸'}</span>
 <span>{rn}</span>
 <span style={{ color: pass === total ? '#52c41a' : '#faad14', marginLeft: 'auto' }}>{pass}/{total}</span>
 </div>
 {isExpanded && items.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)).map((item: any) => {
 const s = item.status || 'unchecked'
 return (
 <div key={item.template_id} style={{ display: 'flex', alignItems: 'center', padding: '2px 0 2px 20px', gap: 6, fontSize: 11 }}>
 <span style={{ color: statusColor[s], fontSize: 12 }}>{statusDisplay[s]}</span>
 <span>{item.item_text}</span>
 </div>
 )
 })}
 </div>
 )
 })}
 </div>
 )
}

// ============================================================
// 入口
// ============================================================
ReactDOM.render(<App />, document.getElementById('ones-mf-root'))
