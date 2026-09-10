import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { apiGet, apiPost, deleteProjectBinding, getTeamUUID, upsertProjectBinding } from '../../api'

type NavKey = 'phases' | 'materials' | 'indicators' | 'roles' | 'checklist' | 'resolution' | 'notify' | 'ipdflow' | 'recall' | 'remediation' | 'profiles'

const NAV: { key: NavKey; label: string }[] = [
 { key: 'phases', label: '节点模板' },
 { key: 'materials', label: '材料模板' },
 { key: 'indicators', label: '指标模板' },
 { key: 'roles', label: '评审角色' },
 { key: 'checklist', label: 'Checklist' },
 { key: 'resolution', label: '决议规则' },
 { key: 'ipdflow', label: 'IPD流程图' },
 { key: 'notify', label: '通知设置' },
 { key: 'recall', label: '撤回设置' },
 { key: 'remediation', label: '整改设置' },
 { key: 'profiles', label: '评审人Profile' },
]

function jsonArr(s: string): string[] {
 try { const a = JSON.parse(s); return Array.isArray(a) ? a : [] } catch { return [] }
}

function jsonArrObj(s: string): any[] {
 try {
  const a = JSON.parse(s)
  return Array.isArray(a) ? a.filter((x: any) => x && typeof x === 'object') : []
 } catch {
  return []
 }
}

// ---- 样式 ----
const S: Record<string, any> = {
 container: { display: 'flex', height: '100%', fontFamily: 'sans-serif', fontSize: 13, color: '#333' },
 nav: { width: 160, borderRight: '1px solid #e8e8e8', padding: '12px 0', background: '#fafafa', flexShrink: 0 },
 navItem: (a: boolean): React.CSSProperties => ({
 padding: '10px 16px', cursor: 'pointer', fontSize: 13,
 color: a ? '#1677ff' : '#333', background: a ? '#e6f4ff' : 'transparent',
 borderRight: a ? '2px solid #1677ff' : '2px solid transparent', fontWeight: a ? 600 : 400,
 }),
 content: { flex: 1, padding: 20, overflow: 'auto', paddingBottom: 80 },
 sectionTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } as React.CSSProperties,
 input: { padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13, width: '100%', boxSizing: 'border-box' as any },
 select: { padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13 },
 textarea: { padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13, width: '100%', resize: 'vertical' as any, boxSizing: 'border-box' as any },
 row: { display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0', alignItems: 'center' },
 addBtn: { padding: '4px 12px', border: '1px dashed #d9d9d9', borderRadius: 4, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#1677ff' },
 delBtn: { padding: '2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', color: '#ff4d4f', fontSize: 14 },
 saveBar: { position: 'fixed' as any, bottom: 0, left: 160, right: 0, padding: '10px 20px', background: '#fff', borderTop: '1px solid #e8e8e8', display: 'flex', gap: 12, alignItems: 'center', zIndex: 10 },
 btn: (p: boolean, d = false) => ({ padding: '6px 20px', borderRadius: 4, border: 'none', cursor: d ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500, background: p ? '#1677ff' : '#f0f0f0', color: p ? '#fff' : '#333', opacity: d ? 0.6 : 1 }),
 card: { padding: 16, border: '1px solid #e8e8e8', borderRadius: 6, background: '#fff' },
 table: { width: '100%', borderCollapse: 'separate', borderSpacing: 0, border: '1px solid #e8e8e8', borderRadius: 6, overflow: 'visible', background: '#fff' },
 th: { padding: '10px 14px', background: '#fafafa', borderBottom: '1px solid #e8e8e8', color: '#666', fontSize: 12, fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap' },
 td: { padding: '12px 14px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'middle', color: '#333' },
}

// ============================================================
// 主组件
// ============================================================
const App: React.FC = () => {
 const [nav, setNav] = useState<NavKey>('phases')
 const [reviewType, setReviewType] = useState<'dcp' | 'tr'>('dcp')
 const [loading, setLoading] = useState(true)
 const [saving, setSaving] = useState(false)
 const [message, setMessage] = useState('')
 const [editing, setEditing] = useState(false) // 编辑态开关

 const [phases, setPhases] = useState<any[]>([])
 const [materials, setMaterials] = useState<any[]>([])
 const [indicators, setIndicators] = useState<any[]>([])
 const [roles, setRoles] = useState<any[]>([])
 const [checklistItems, setChecklistItems] = useState<any[]>([])
 const [notifyConfig, setNotifyConfig] = useState<any>({ enabled: true, on_review_start: true, on_all_submitted: true, on_resolution: true, on_manual_remind: true, remind_cooldown_seconds: 60, channels: { email: true, wechat: false, dingtalk: false, feishu: false, youdao: false } })
 const [ipdFlowLayout, setIpdFlowLayout] = useState<any>(null)
 const [resolutionRules, setResolutionRules] = useState<any>({ dcp: null, tr: null })
 const [recallConfig, setRecallConfig] = useState<any>({ enabled: false, allowedBeforeResolution: true, requireReason: true, clearSubmittedOpinions: true })
 const [remediationIssueType, setRemediationIssueType] = useState('')
 const [remediationIssueTypeUuid, setRemediationIssueTypeUuid] = useState('')
 const [profiles, setProfiles] = useState<any[]>([])
 const [projectBindings, setProjectBindings] = useState<any[]>([])

 useEffect(() => { loadConfig() }, [])

 async function loadConfig(showLoading = true) {
 if (showLoading) setLoading(true)
 try {
 const [data, profileData, bindingData] = await Promise.all([
 apiGet('/dcp/config'),
 apiGet('/dcp/reviewer-profiles'),
 apiGet('/dcp/project-bindings'),
 ])
 // 后端 getPluginConfig 返回 { config, phases, materials, indicators, roles }
 // 兼容旧数据：拆分逗号分隔的 resolution_options，默认 dependencies
 const normPhase = (p: any) => {
 const ro = jsonArr(p.resolution_options || '[]')
 const needsSplit = ro.some((x: string) => typeof x === 'string' && (x.includes(',') || x.includes('，')))
 const fixedRo = needsSplit ? ro.flatMap((x: string) => x.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)) : ro
 return { ...p, review_type: p.review_type || 'dcp', dependencies: p.dependencies || '[]', resolution_options: JSON.stringify(fixedRo) }
 }
 const phs = (data.phases || []).map(normPhase)
 if (phs.length) {
 setPhases(phs)
 }
 if (data.materials?.length) setMaterials(data.materials.map((m: any) => ({ ...m, review_type: m.review_type || 'dcp' })))
 if (data.indicators?.length) setIndicators(data.indicators.map((i: any) => ({ ...i, review_type: i.review_type || 'dcp' })))
 if (data.roles?.length) setRoles(data.roles.map((r: any) => ({ ...r, review_type: r.review_type || 'dcp' })))
 if (data.checklistItems?.length) setChecklistItems(data.checklistItems.map((c: any) => ({ ...c, review_type: c.review_type || 'dcp' })))
 if (data.notify_config) setNotifyConfig(data.notify_config)
 if (data.review_recall_config) setRecallConfig(data.review_recall_config)
 setRemediationIssueType(data.config?.remediation_issue_type || '')
 setRemediationIssueTypeUuid(data.config?.remediation_issue_type_uuid || '')
 if (data.ipd_flow_layout) setIpdFlowLayout(data.ipd_flow_layout)
 if (data.resolution_rule_config) setResolutionRules(data.resolution_rule_config)
 setProfiles(profileData.profiles || [])
 setProjectBindings(bindingData.bindings || [])
 } catch (err: any) { setMessage('加载失败: ' + err.message) }
 finally { if (showLoading) setLoading(false) }
 }

 async function handleSave() {
 setSaving(true); setMessage('')
 try {
 if (phases.every(p => !p.phase_name)) { setMessage('至少需要填一个阶段名称'); setSaving(false); return }
 if (remediationIssueType.trim() && !remediationIssueTypeUuid) {
   setMessage('整改工作项默认类型必须从团队已有工作项类型中选择')
   setSaving(false)
   return
 }
 const normPhase = (arr: any[]) => arr.map(x => ({ ...x, review_type: x.review_type || 'dcp', dependencies: x.dependencies || '[]' }))
 const normType = (arr: any[]) => arr.map(x => ({ ...x, review_type: x.review_type || 'dcp' }))
 const body = {
 phases: normPhase(phases.filter(p => p.phase_name)),
 materials: normType(materials), indicators: normType(indicators), roles: normType(roles),
 checklistItems: normType(checklistItems),
 notify_config: notifyConfig,
 review_recall_config: recallConfig,
 ipd_flow_layout: ipdFlowLayout,
 resolution_rule_config: resolutionRules,
 config: {
   remediation_issue_type: remediationIssueType,
   remediation_issue_type_uuid: remediationIssueTypeUuid,
 },
 }
 const res = await apiPost('/dcp/config', body)
 if (res.error) { setMessage('保存失败: ' + res.error) }
 else { setMessage('配置已保存。'); setEditing(false) }
 } catch (err: any) { setMessage('保存失败: ' + err.message) }
 finally { setSaving(false) }
 }

 if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>加载配置…</div>

 return (
 <div style={S.container}>
 <div style={S.nav}>
 {NAV.map(item => (
 <div key={item.key} style={S.navItem(nav === item.key)} onClick={() => { setNav(item.key); if (item.key === 'profiles') setEditing(false) }}>{item.label}</div>
 ))}
 </div>
 <div style={S.content}>
 {/* DCP / TR 类型切换（IPD流程图、通知设置、撤回设置、整改设置为全局配置，不区分 DCP/TR） */}
 {nav !== 'ipdflow' && nav !== 'notify' && nav !== 'recall' && nav !== 'remediation' && (
 <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid #e8e8e8' }}>
 {(['dcp', 'tr'] as const).map(t => (
 <button key={t} onClick={() => setReviewType(t)}
 style={{ padding: '6px 20px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14,
 borderBottom: reviewType === t ? '2px solid #1677ff' : '2px solid transparent',
 color: reviewType === t ? '#1677ff' : '#666', fontWeight: reviewType === t ? 600 : 400 }}>
 {t === 'dcp' ? 'DCP 决策评审' : 'TR 技术评审'}
 </button>
 ))}
 </div>
 )}
 {!editing && nav !== 'profiles' && (
 <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
 <button style={S.btn(true)} onClick={() => { setEditing(true); setMessage('') }}>配置</button>
 </div>
 )}
 {nav === 'phases' && <PhaseTemplates phases={phases.filter((p: any) => (p.review_type || 'dcp') === reviewType)} allPhases={phases} onChange={(v) => { const other = phases.filter((p: any) => (p.review_type || 'dcp') !== reviewType); setPhases([...other, ...v.map((x: any) => ({ ...x, review_type: reviewType }))]) }} editing={editing} reviewType={reviewType} />}
 {nav === 'materials' && <MaterialTemplates items={materials.filter((m: any) => (m.review_type || 'dcp') === reviewType)} onChange={(v) => { const other = materials.filter((m: any) => (m.review_type || 'dcp') !== reviewType); setMaterials([...other, ...v.map((x: any) => ({ ...x, review_type: reviewType }))]) }} editing={editing} phaseObjs={phases.filter((p: any) => (p.review_type || 'dcp') === reviewType).map((p: any) => ({ code: p.phase_code, name: p.phase_name || p.phase_code }))} />}
 {nav === 'indicators' && <IndicatorTemplates items={indicators.filter((i: any) => (i.review_type || 'dcp') === reviewType)} onChange={(v) => { const other = indicators.filter((i: any) => (i.review_type || 'dcp') !== reviewType); setIndicators([...other, ...v.map((x: any) => ({ ...x, review_type: reviewType }))]) }} editing={editing} phaseObjs={phases.filter((p: any) => (p.review_type || 'dcp') === reviewType).map((p: any) => ({ code: p.phase_code, name: p.phase_name || p.phase_code }))} />}
 {nav === 'roles' && <RoleRules items={roles.filter((r: any) => (r.review_type || 'dcp') === reviewType)} onChange={(v) => { const other = roles.filter((r: any) => (r.review_type || 'dcp') !== reviewType); setRoles([...other, ...v.map((x: any) => ({ ...x, review_type: reviewType }))]) }} editing={editing} />}
 {nav === 'checklist' && <ChecklistConfigPanel items={checklistItems.filter((c: any) => (c.review_type || 'dcp') === reviewType)} roles={roles.filter((r: any) => (r.review_type || 'dcp') === reviewType)} onChange={(v) => { const other = checklistItems.filter((c: any) => (c.review_type || 'dcp') !== reviewType); setChecklistItems([...other, ...v.map((x: any) => ({ ...x, review_type: reviewType }))]) }} editing={editing} phases={phases.filter((p: any) => (p.review_type || 'dcp') === reviewType)} />}
 {nav === 'resolution' && <ResolutionRuleConfig rules={resolutionRules} roles={roles} onChange={setResolutionRules} editing={editing} reviewType={reviewType} />}
 {nav === 'ipdflow' && <IpdFlowLayoutConfig layout={ipdFlowLayout} phases={phases} onChange={setIpdFlowLayout} editing={editing} />}
 {nav === 'notify' && <NotifySettings config={notifyConfig} onChange={setNotifyConfig} editing={editing} />}
 {nav === 'recall' && <RecallSettings config={recallConfig} onChange={setRecallConfig} editing={editing} />}
 {nav === 'remediation' && <RemediationSettings
   issueType={remediationIssueType}
   issueTypeUuid={remediationIssueTypeUuid}
   onChange={(name, uuid) => { setRemediationIssueType(name); setRemediationIssueTypeUuid(uuid) }}
   editing={editing}
 />}
 {nav === 'profiles' && <ReviewerProfilesPanel profiles={profiles.filter((p: any) => (p.review_type || 'dcp') === reviewType)} projectBindings={projectBindings.filter((b: any) => (b.review_type || 'dcp') === reviewType)} roles={roles.filter((r: any) => (r.review_type || 'dcp') === reviewType)} reviewType={reviewType} onRefresh={() => loadConfig(false)} />}
 </div>
 {editing && nav !== 'profiles' && (
 <div style={S.saveBar}>
 <button style={S.btn(true, saving)} disabled={saving} onClick={handleSave}>{saving ? '保存中…' : '保存'}</button>
 <button style={S.btn(false)} onClick={() => { setEditing(false); loadConfig() }}>取消</button>
 {message && <span style={{ fontSize: 13, color: message.startsWith('') ? '#ff4d4f' : '#52c41a' }}>{message}</span>}
 </div>
 )}
 </div>
 )
}

// ============================================================
// 节点模板（动态可增删）
// ============================================================
const PhaseTemplates: React.FC<{ phases: any[]; allPhases: any[]; onChange: (v: any[]) => void; editing: boolean; reviewType: string }> = ({ phases, allPhases, onChange, editing, reviewType }) => {
 const RESOLUTION_PRESETS = reviewType === 'tr'
 ? ['通过', '有条件通过', '不通过', '返工', '否决']
 : ['通过', '有条件通过', '否决', '重新评审']

 function add() {
 const prefix = reviewType === 'tr' ? 'TR' : 'DCP'
 let maxNum = 0
 phases.forEach(p => {
 const m = (p.phase_code || '').match(new RegExp(`^${prefix}(\\d+)$`))
 if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
 })
 const nextCode = `${prefix}${maxNum + 1}`
 onChange([...phases, { phase_code: nextCode, phase_name: '', resolution_options: JSON.stringify(RESOLUTION_PRESETS.slice(0, 3)), resolution_template: '', dependencies: '[]', sort_order: phases.length }])
 }
 function update(idx: number, key: string, value: any) {
 const items = [...phases]; items[idx] = { ...items[idx], [key]: value }; onChange(items)
 }
 function toggleArrayItem(idx: number, key: string, item: string) {
 const arr = jsonArr(phases[idx][key] || '[]')
 const next = arr.includes(item) ? arr.filter((x: string) => x !== item) : [...arr, item]
 update(idx, key, JSON.stringify(next))
 }
 function remove(idx: number) { onChange(phases.filter((_, i) => i !== idx)) }

 function chipStyle(selected: boolean): React.CSSProperties {
 return {
 padding: '3px 10px', borderRadius: 4, fontSize: 12, userSelect: 'none',
 cursor: editing ? 'pointer' : 'default',
 background: selected ? '#e6f4ff' : '#f5f5f5',
 color: selected ? '#1677ff' : '#999',
 border: selected ? '1px solid #91caff' : '1px solid #e8e8e8',
 transition: 'all .15s',
 }
 }

 return (
 <div>
 <div style={S.sectionTitle}><span>{reviewType === 'tr' ? 'TR' : 'DCP'} 节点配置（{phases.length}个节点）</span>{editing && <button style={S.addBtn} onClick={add}>+ 添加节点</button>}</div>
 {phases.length === 0 ? <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>暂无节点配置，请点击「+ 添加节点」创建</div> :
 phases.map((p, i) => {
 const resOpts = jsonArr(p.resolution_options || '[]')
 const deps = jsonArr(p.dependencies || '[]')
 return (
 <div key={i} style={{ ...S.card, marginBottom: 12, background: '#fafafa' }}>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
 <span style={{ fontWeight: 600, fontSize: 14 }}>{p.phase_code} · 阶段 {i + 1}</span>
 {editing && <button style={S.delBtn} onClick={() => remove(i)}>删除</button>}
 </div>
 <div style={S.row}>
 <span style={{ width: 80, fontSize: 12, color: '#666' }}>名称 *</span>
 <input style={S.input} value={p.phase_name || ''}
 onChange={e => update(i, 'phase_name', e.target.value)} placeholder="如：概念决策评审" disabled={!editing} />
 </div>
 <div style={S.row}>
 <span style={{ width: 80, fontSize: 12, color: '#666' }}>决议选项 *</span>
 <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, alignItems: 'center' }}>
 {RESOLUTION_PRESETS.map(opt => {
 const sel = resOpts.includes(opt)
 return <span key={opt} style={chipStyle(sel)} onClick={() => editing && toggleArrayItem(i, 'resolution_options', opt)}>{opt}</span>
 })}
 {resOpts.length === 0 && editing && <span style={{ color: '#ff4d4f', fontSize: 11 }}>至少选1项</span>}
 </div>
 </div>
 <div style={S.row}>
 <span style={{ width: 80, fontSize: 12, color: '#666' }}>前置依赖</span>
 <div style={{ flex: 1 }}>
 <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>前置阶段的最终决议须为"通过"或"有条件通过"才能发起当前阶段评审</div>
 <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
 {allPhases.filter(ap => ap.phase_code !== p.phase_code && ap.phase_name).length === 0 ? (
 <span style={{ fontSize: 12, color: '#bbb' }}>暂无其他已命名阶段可选</span>
 ) : allPhases.filter(ap => ap.phase_code !== p.phase_code).map(ap => {
 const sel = deps.includes(ap.phase_code)
 const tag = (ap.review_type || 'dcp') === 'tr' ? '' : ''
 return <span key={ap.phase_code} style={chipStyle(sel)} onClick={() => editing && toggleArrayItem(i, 'dependencies', ap.phase_code)}>{tag} {ap.phase_name}</span>
 })}
 </div>
 </div>
 </div>
 <div style={{ ...S.row, borderBottom: 'none' }}>
 <span style={{ width: 80, fontSize: 12, color: '#666' }}>模板文本</span>
 <textarea style={S.textarea} rows={3} value={p.resolution_template || ''}
 onChange={e => update(i, 'resolution_template', e.target.value)}
 placeholder="决议模板，可在生成决议时引用…" disabled={!editing} />
 </div>
 </div>
 )
 })
 }
 </div>
 )
}

// ============================================================
// 材料模板
// ============================================================
const MaterialTemplates: React.FC<{ items: any[]; onChange: (v: any[]) => void; editing: boolean; phaseObjs: { code: string; name: string }[] }> = ({ items, onChange, editing, phaseObjs }) => {
 function add() {
 onChange([...items, { material_name: '', applicable_phases: '[]', required: true, sort_order: items.length }])
 }
 function update(idx: number, key: string, value: any) {
 const list = [...items]; list[idx] = { ...list[idx], [key]: value }; onChange(list)
 }
 function updatePhases(idx: number, phs: string[]) { update(idx, 'applicable_phases', JSON.stringify(phs)) }
 function remove(idx: number) { onChange(items.filter((_, i) => i !== idx)) }

 return (
 <div>
 <div style={S.sectionTitle}><span>材料模板（{items.length}项）</span>{editing && <button style={S.addBtn} onClick={add}>+ 添加</button>}</div>
 {items.length === 0 ? <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>暂无材料模板</div> :
 items.map((m, i) => (
 <div key={i} style={S.row}>
 <input style={{ ...S.input, flex: 2 }} value={m.material_name} onChange={e => update(i, 'material_name', e.target.value)} placeholder="材料名称" disabled={!editing} />
 <PhaseSelector selected={jsonArr(m.applicable_phases)} onChange={v => updatePhases(i, v)} disabled={!editing} phases={phaseObjs} />
 <label style={{ fontSize: 12, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
 <input type="checkbox" checked={m.required} onChange={e => update(i, 'required', e.target.checked)} disabled={!editing} />必交
 </label>
 {editing && <button style={S.delBtn} onClick={() => remove(i)}>×</button>}
 </div>
 ))}
 </div>
 )
}

// ============================================================
// 指标模板
// ============================================================
const IndicatorTemplates: React.FC<{ items: any[]; onChange: (v: any[]) => void; editing: boolean; phaseObjs: { code: string; name: string }[] }> = ({ items, onChange, editing, phaseObjs }) => {
 function add() {
 onChange([...items, { indicator_name: '', applicable_phases: '[]', unit: '', threshold_type: '高于阈值预警', yellow_threshold: 0, red_threshold: 0, sort_order: items.length }])
 }
 function update(idx: number, key: string, value: any) {
 const list = [...items]; list[idx] = { ...list[idx], [key]: value }; onChange(list)
 }
 function updatePhases(idx: number, phs: string[]) { update(idx, 'applicable_phases', JSON.stringify(phs)) }
 function remove(idx: number) { onChange(items.filter((_, i) => i !== idx)) }

 return (
 <div>
 <div style={S.sectionTitle}><span>指标模板（{items.length}项）</span>{editing && <button style={S.addBtn} onClick={add}>+ 添加</button>}</div>
 {items.length === 0 ? <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>暂无指标模板</div> :
 items.map((ind, i) => (
 <div key={i} style={S.row}>
 <input style={{ ...S.input, flex: 2 }} value={ind.indicator_name} onChange={e => update(i, 'indicator_name', e.target.value)} placeholder="指标名称" disabled={!editing} />
 <PhaseSelector selected={jsonArr(ind.applicable_phases)} onChange={v => updatePhases(i, v)} disabled={!editing} phases={phaseObjs} />
 <input style={{ ...S.input, width: 60 }} value={ind.unit} onChange={e => update(i, 'unit', e.target.value)} placeholder="单位" disabled={!editing} />
 <select style={S.select} value={ind.threshold_type} onChange={e => update(i, 'threshold_type', e.target.value)} disabled={!editing}>
 <option value="达标即通过">达标即通过</option><option value="高于阈值预警">高于阈值预警</option><option value="低于阈值预警">低于阈值预警</option>
 </select>
 <input type="number" style={{ ...S.input, width: 70 }} value={ind.yellow_threshold} onChange={e => update(i, 'yellow_threshold', parseFloat(e.target.value) || 0)} placeholder="黄" disabled={!editing} />
 <input type="number" style={{ ...S.input, width: 70 }} value={ind.red_threshold} onChange={e => update(i, 'red_threshold', parseFloat(e.target.value) || 0)} placeholder="红" disabled={!editing} />
 {editing && <button style={S.delBtn} onClick={() => remove(i)}>×</button>}
 </div>
 ))}
 </div>
 )
}

// ============================================================
// 评审角色
// ============================================================
const RoleRules: React.FC<{ items: any[]; onChange: (v: any[]) => void; editing: boolean }> = ({ items, onChange, editing }) => {
 function add() {
 onChange([...items, { role_name: '', must_vote: true, has_veto: false, sort_order: items.length }])
 }
 function update(idx: number, key: string, value: any) {
 const list = [...items]; list[idx] = { ...list[idx], [key]: value }; onChange(list)
 }
 function remove(idx: number) { onChange(items.filter((_, i) => i !== idx)) }

 return (
 <div>
 <div style={S.sectionTitle}>
 <span>评审角色配置（{items.length}个角色）</span>
 {editing && <button style={S.addBtn} onClick={add}>+ 添加角色</button>}
 </div>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 12 }}>配置评审角色名称及属性。「必投」=该角色必须指定评审人才能发起评审；「否决权」=该角色可否决决议</div>
 {items.length === 0 ? <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>暂无角色，请点击「+ 添加角色」创建</div> :
 items.map((r, i) => (
 <div key={i} style={{ ...S.row, justifyContent: 'flex-start' }}>
 <input style={{ ...S.input, width: 160, fontWeight: 500 }} value={r.role_name || ''}
 onChange={e => update(i, 'role_name', e.target.value)} placeholder="角色名称（如：Chair、TR负责人）" disabled={!editing} />
 <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginRight: 16 }}>
 <input type="checkbox" checked={r.must_vote} onChange={e => update(i, 'must_vote', e.target.checked)} disabled={!editing} />必投
 </label>
 <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginRight: 16 }}>
 <input type="checkbox" checked={r.has_veto} onChange={e => update(i, 'has_veto', e.target.checked)} disabled={!editing} />否决权
 </label>
 {editing && <button style={S.delBtn} onClick={() => remove(i)}>×</button>}
 </div>
 ))
 }
 </div>
 )
}

// ============================================================
// Checklist 配置面板
// ============================================================
const ChecklistConfigPanel: React.FC<{ items: any[]; roles: any[]; onChange: (v: any[]) => void; editing: boolean; phases: any[] }> = ({ items, roles, onChange, editing, phases }) => {
 const phaseList = phases.map((p: any) => ({ code: p.phase_code, name: p.phase_name || p.phase_code }))
 const [phaseIdx, setPhaseIdx] = useState(0)
 const [newItemText, setNewItemText] = useState('')
 const [newItemRole, setNewItemRole] = useState(roles[0]?.role_name || '')
 const phaseCode = phaseList[phaseIdx]?.code || ''

 function addItem() {
 if (!newItemText.trim() || !newItemRole) return
 const count = items.filter((i: any) => i.phase_code === phaseCode).length
 if (count >= 20) return // 每阶段上限20
 onChange([...items, {
 phase_code: phaseCode,
 role_name: newItemRole,
 item_text: newItemText.trim(),
 sort_order: count,
 }])
 setNewItemText('')
 }

 function removeItem(idx: number) {
 onChange(items.filter((_, i) => i !== idx))
 }

 // 按阶段过滤，按角色分组
 const phaseItems = items.filter((i: any) => i.phase_code === phaseCode)
 const grouped: Record<string, any[]> = {}
 for (const item of phaseItems) {
 if (!grouped[item.role_name]) grouped[item.role_name] = []
 grouped[item.role_name].push(item)
 }

 const roleNames = Object.keys(grouped)
 const totalInPhase = phaseItems.length

 return (
 <div>
 <h3 style={{ fontSize: 16, marginBottom: 16 }}>Checklist 配置</h3>
 <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>按阶段 → 角色组织检查项。每阶段上限 20 个。</div>
 {/* 阶段选择 */}
 <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
 {phaseList.map((p, i) => (
 <button key={p.code} onClick={() => setPhaseIdx(i)} style={{
 padding: '6px 16px', border: 'none', borderRadius: 4,
 background: phaseIdx === i ? '#1677ff' : '#f0f0f0', color: phaseIdx === i ? '#fff' : '#333',
 cursor: 'pointer', fontSize: 13, fontWeight: phaseIdx === i ? 600 : 400,
 }}>{p.name} ({items.filter((it: any) => it.phase_code === p.code).length})</button>
 ))}
 </div>

 {/* 按角色分组展示 */}
 {roleNames.length === 0 ? (
 <div style={{ color: '#999', padding: 20, textAlign: 'center' }}>该阶段暂无检查项</div>
 ) : (
 roleNames.map(rn => {
 const roleItems = grouped[rn]
 return (
 <div key={rn} style={{ marginBottom: 20 }}>
 <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{rn}</div>
 {roleItems.map((item, idx) => {
 const globalIdx = items.indexOf(item)
 return (
 <div key={idx} style={{ ...S.row, justifyContent: 'flex-start', paddingLeft: 8 }}>
 <span style={{ flex: 1, fontSize: 13 }}>☑ {item.item_text}</span>
 {editing && <button style={S.delBtn} onClick={() => removeItem(globalIdx)}>×</button>}
 </div>
 )
 })}
 </div>
 )
 })
 )}

 {/* 添加检查项 */}
 {editing && totalInPhase < 20 && (
 <div style={{ marginTop: 16, padding: '10px 12px', background: '#f9f9f9', borderRadius: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
 <select style={S.select} value={newItemRole} onChange={e => setNewItemRole(e.target.value)}>
 {roles.map((r: any) => <option key={r.role_name} value={r.role_name}>{r.role_name}</option>)}
 {roles.length === 0 && <option value="">无角色</option>}
 </select>
 <input style={{ ...S.input, flex: 2 }} value={newItemText} onChange={e => setNewItemText(e.target.value)} placeholder="输入检查项描述…" onKeyDown={e => e.key === 'Enter' && addItem()} />
 <button style={S.btn(true)} onClick={addItem}>+ 添加</button>
 </div>
 )}
 {editing && totalInPhase >= 20 && (
 <div style={{ marginTop: 16, color: '#faad14', fontSize: 12 }}>该阶段已达 20 项上限</div>
 )}
 </div>
 )
}

// ============================================================
// 阶段多选组件
// ============================================================
const PhaseSelector: React.FC<{ selected: string[]; onChange: (v: string[]) => void; disabled?: boolean; phases: { code: string; name: string }[] }> = ({ selected, onChange, disabled, phases }) => {
 const [open, setOpen] = useState(false)
 const ref = React.useRef<HTMLDivElement>(null)
 function toggle(code: string) {
 if (disabled) return
 if (selected.includes(code)) onChange(selected.filter(p => p !== code))
 else onChange([...selected, code])
 }
 // 选中项的名称展示
 const selectedNames = selected.map(code => phases.find(p => p.code === code)?.name || code)
 // 点击外部关闭
 useEffect(() => {
 if (!open || disabled) return
 function handleClick(e: MouseEvent) {
 if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
 }
 document.addEventListener('mousedown', handleClick)
 return () => document.removeEventListener('mousedown', handleClick)
 }, [open, disabled])
 return (
 <div ref={ref} style={{ position: 'relative', minWidth: 120 }}>
 <div onClick={() => { if (!disabled) setOpen(!open) }} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 12, cursor: disabled ? 'default' : 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', background: disabled ? '#f5f5f5' : '#fff', color: disabled ? '#999' : '#333' }}>
 {selectedNames.length > 0 ? selectedNames.join(', ') : <span style={{ color: '#999' }}>选择阶段</span>}
 </div>
 {open && !disabled && (
 <div style={{ position: 'absolute', top: 32, left: 0, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4, padding: 8, zIndex: 100, minWidth: 160, boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
 {phases.map(p => (
 <label key={p.code} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', cursor: 'pointer', fontSize: 12 }}>
 <input type="checkbox" checked={selected.includes(p.code)} onChange={() => toggle(p.code)} />{p.name}
 </label>
 ))}
 </div>
 )}
 </div>
 )
}

// ============================================================
// 通知设置
// ============================================================
const NOTIFY_CHANNELS = [
 { key: 'email', label: '📧 邮件' },
 { key: 'wechat', label: '💬 企业微信' },
 { key: 'dingtalk', label: '📌 钉钉' },
 { key: 'feishu', label: '🐦 飞书' },

 { key: 'youdao', label: '🔷 有度' },
]

const NotifySettings: React.FC<{ config: any; onChange: (c: any) => void; editing: boolean }> = ({ config, onChange, editing }) => {
 const c = config || {}
 const ch = c.channels || {}
 function toggle(key: string) {
 if (!editing) return
 if (key === 'on_manual_remind') {
   const cur = c.on_manual_remind !== false
   onChange({ ...c, on_manual_remind: !cur })
   return
 }
 onChange({ ...c, [key]: !c[key] })
 }
 function toggleChannel(key: string) {
 if (!editing) return
 onChange({ ...c, channels: { ...ch, [key]: !ch[key] } })
 }
 const prefix = editing ? '' : ''
 return (
 <div>
 <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{prefix} 通知设置 {editing ? '— 编辑中' : '— 只读'}</div>
 {!editing && <div style={{ marginBottom: 16, color: '#999', fontSize: 12 }}>点击右上角「配置」进入编辑模式后可修改</div>}

 {/* 全局开关 */}
 <div style={{ marginBottom: 20, padding: 12, background: '#f9f9f9', borderRadius: 8 }}>
 <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: editing ? 'pointer' : 'default', fontWeight: 600, fontSize: 14 }}>
 <input type="checkbox" checked={!!c.enabled} onChange={() => toggle('enabled')} disabled={!editing} />
 启用通知
 </label>
 <div style={{ marginTop: 4, color: '#999', fontSize: 12, marginLeft: 26 }}>关闭后所有通知均不发送</div>
 </div>

 {/* 通知场景 */}
 <div style={{ marginBottom: 20 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>通知场景</div>
 <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
 <input type="checkbox" checked={!!c.on_review_start} onChange={() => toggle('on_review_start')} disabled={!editing} />
 发起评审时通知评审人
 </label>
 <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
 <input type="checkbox" checked={!!c.on_all_submitted} onChange={() => toggle('on_all_submitted')} disabled={!editing} />
 全体评审人提交后通知决议发布人
 </label>
 <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
 <input type="checkbox" checked={!!c.on_resolution} onChange={() => toggle('on_resolution')} disabled={!editing} />
 决议发布后通知创建者及评审人
 </label>
 <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
 <input type="checkbox" checked={c.on_manual_remind !== false} onChange={() => toggle('on_manual_remind')} disabled={!editing} />
 允许手动催办（评审发起人催办评审人/决议人）
 </label>
 </div>

 {/* 催办冷却时间 */}
 <div style={{ marginBottom: 20 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>催办冷却时间</div>
 <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
 <select style={S.select} value={String(c.remind_cooldown_seconds || 60)} disabled={!editing}
 onChange={e => onChange({ ...c, remind_cooldown_seconds: parseInt(e.target.value) })}>
 <option value="60">1 分钟</option>
 <option value="300">5 分钟</option>
 <option value="600">10 分钟</option>
 </select>
 <span style={{ color: '#999', fontSize: 12 }}>同一评审单同一类型催办的最短间隔</span>
 </div>
 </div>

 {/* 通知渠道 */}
 <div style={{ marginBottom: 20 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>通知渠道</div>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>注：需要 ONES 管理员先完成对应三方系统的集成配置</div>
 {NOTIFY_CHANNELS.map(item => (
 <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: editing ? 'pointer' : 'default' }}>
 <input type="checkbox" checked={!!ch[item.key]} onChange={() => toggleChannel(item.key)} disabled={!editing} />
 {item.label}
 </label>
 ))}
 </div>
 </div>
 )
}

// ============================================================
// 评审撤回设置
// ============================================================
const RecallSettings: React.FC<{ config: any; onChange: (c: any) => void; editing: boolean }> = ({ config, onChange, editing }) => {
 const c = config || {}
 function toggle(key: string) {
   if (!editing) return
   onChange({ ...c, [key]: !c[key] })
 }
 return (
 <div>
   <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>评审撤回设置 {editing ? '— 编辑中' : '— 只读'}</div>
   {!editing && <div style={{ marginBottom: 16, color: '#999', fontSize: 12 }}>点击右上角「配置」进入编辑模式后可修改</div>}

   <div style={{ marginBottom: 20, padding: 12, background: '#f9f9f9', borderRadius: 8 }}>
     <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: editing ? 'pointer' : 'default', fontWeight: 600, fontSize: 14 }}>
       <input type="checkbox" checked={!!c.enabled} onChange={() => toggle('enabled')} disabled={!editing} />
       允许发起人撤回已发起评审
     </label>
     <div style={{ marginTop: 4, color: '#999', fontSize: 12, marginLeft: 26 }}>
       开启后，评审发起人可以在评审中且未发布决议时撤回评审，撤回后回到草稿状态
     </div>
   </div>

   <div style={{ marginBottom: 20 }}>
     <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
       <input type="checkbox" checked={!!c.requireReason} onChange={() => toggle('requireReason')} disabled={!editing} />
       撤回时必须填写原因
     </label>
     <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: editing ? 'pointer' : 'default' }}>
       <input type="checkbox" checked={!!c.clearSubmittedOpinions} onChange={() => toggle('clearSubmittedOpinions')} disabled={!editing} />
       撤回时清空已提交评审意见和 Checklist
     </label>
   </div>

   <div style={{ padding: '8px 12px', borderRadius: 4, fontSize: 12, background: '#fff7e6', color: '#faad14' }}>
     ⚠ 撤回后评审单回到草稿状态，已提交的评审意见、Checklist 状态将被清空，评审人待办和决议待办将失效。
   </div>
 </div>
 )
}

// ============================================================
// 整改设置
// ============================================================
const RemediationSettings: React.FC<{
 issueType: string
 issueTypeUuid: string
 onChange: (name: string, uuid: string) => void
 editing: boolean
}> = ({ issueType, issueTypeUuid, onChange, editing }) => {
 const [issueTypes, setIssueTypes] = useState<{ uuid: string; name: string }[]>([])
 const [loading, setLoading] = useState(false)
 const [open, setOpen] = useState(false)
 const ref = React.useRef<HTMLDivElement>(null)

 useEffect(() => {
  const tu = getTeamUUID()
  if (!tu) return
  setLoading(true)
  fetch(`/project/api/project/team/${tu}/items/graphql?t=issueTypes`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ issueTypes(orderBy: { namePinyin: ASC }) { uuid name } }', variables: {} }),
  })
    .then(r => r.json())
    .then(gql => {
      const raw = gql?.data?.issueTypes || []
      setIssueTypes(raw.map((t: any) => ({ uuid: t.uuid || '', name: t.name || '' })).filter((t: any) => t.name))
    })
    .catch(() => {})
    .finally(() => setLoading(false))
 }, [])

 useEffect(() => {
  if (!issueType || issueTypeUuid || issueTypes.length === 0) return
  const matched = issueTypes.find(item => item.name === issueType)
  if (matched) onChange(matched.name, matched.uuid)
 }, [issueType, issueTypeUuid, issueTypes])

 useEffect(() => {
  if (!open) return
  function handleClick(e: MouseEvent) {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
  }
  document.addEventListener('mousedown', handleClick)
  return () => document.removeEventListener('mousedown', handleClick)
 }, [open])

 const kw = issueType.toLowerCase()
 const filtered = kw ? issueTypes.filter(t => t.name.toLowerCase().includes(kw)) : issueTypes

 return (
 <div>
 <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>整改设置 {editing ? '— 编辑中' : '— 只读'}</div>
 {!editing && <div style={{ marginBottom: 16, color: '#999', fontSize: 12 }}>点击右上角「配置」进入编辑模式后可修改</div>}

 <div style={{ marginBottom: 20, padding: 12, background: '#f9f9f9', borderRadius: 8 }}>
 <label style={{ display: 'block', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>整改工作项默认类型</label>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>
   评审决议为「有条件通过」或「返工」后，在整改项区域创建整改工作项时，默认使用此类型。留空则不预填。
 </div>

 {!editing ? (
   <div style={{ ...S.input, background: '#f5f5f5', color: '#666', minHeight: 22 }}>{issueType || '（未设置）'}</div>
 ) : (
   <div ref={ref} style={{ position: 'relative' }}>
     <input
       style={S.input}
       value={issueType}
       onChange={e => { onChange(e.target.value, ''); setOpen(true) }}
       onFocus={() => setOpen(true)}
       placeholder="输入关键字并从团队工作项类型中选择"
     />
     {open && (
       <div style={{ position: 'absolute', top: 34, left: 0, right: 0, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4, maxHeight: 220, overflow: 'auto', zIndex: 100, boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
         {loading && <div style={{ padding: 8, color: '#999', fontSize: 12 }}>加载中…</div>}
         {!loading && filtered.length === 0 && <div style={{ padding: 8, color: '#999', fontSize: 12 }}>无匹配类型</div>}
         {filtered.map(t => {
           const sel = t.uuid === issueTypeUuid || (!issueTypeUuid && t.name === issueType)
           return (
             <div key={t.uuid} onClick={() => { onChange(t.name, t.uuid); setOpen(false) }}
               style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, background: sel ? '#e6f4ff' : 'transparent', color: sel ? '#1677ff' : '#333' }}
               onMouseEnter={e => { if (!sel) e.currentTarget.style.background = '#f5f5f5' }}
               onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent' }}>
               {t.name}
             </div>
           )
         })}
       </div>
     )}
   </div>
 )}
 </div>

 <div style={{ padding: '8px 12px', borderRadius: 4, fontSize: 12, background: '#e6f4ff', color: '#1677ff' }}>
   配置后，评审详情页整改区域创建工作项时将自动预填此类型且不可更改。
 </div>
 </div>
 )
}

// ============================================================
// IPD 流程图布局配置
// ============================================================
const IpdFlowLayoutConfig: React.FC<{ layout: any; phases: any[]; onChange: (v: any) => void; editing: boolean }> = ({ layout, phases, onChange, editing }) => {
 if (!layout) return <div style={{ color: '#999', padding: 20 }}>加载中…</div>
 const stages: any[] = layout.stages || []
 const markers: any[] = layout.markers || []
 const allPhases = phases || []

 function updateStages(newStages: any[]) { onChange({ ...layout, stages: newStages }) }
 function updateMarkers(newMarkers: any[]) { onChange({ ...layout, markers: newMarkers }) }

 function addStage() {
 updateStages([...stages, { code: `stage_${stages.length + 1}`, name: '新阶段', shape: 'rect', widthRatio: 1 }])
 }
 function addMarker() {
 updateMarkers([...markers, { phaseCode: allPhases[0]?.phase_code || '', reviewType: 'dcp', stage: stages[0]?.code || '', position: 0.5, side: 'top', shape: 'diamond' }])
 }

 return (
 <div>
 <div style={S.sectionTitle}><span>主阶段带配置（{stages.length}个）</span>{editing && <button style={S.addBtn} onClick={addStage}>+ 添加主阶段</button>}</div>
 {stages.map((st, i) => (
 <div key={i} style={{ ...S.row, gap: 6, flexWrap: 'wrap' as any }}>
 <input style={{ ...S.input, width: 100 }} value={st.code} disabled={!editing} onChange={e => { const a = [...stages]; a[i] = { ...st, code: e.target.value }; updateStages(a) }} placeholder="code" />
 <input style={{ ...S.input, width: 100 }} value={st.name} disabled={!editing} onChange={e => { const a = [...stages]; a[i] = { ...st, name: e.target.value }; updateStages(a) }} placeholder="名称" />
 <select style={S.select} value={st.shape} disabled={!editing} onChange={e => { const a = [...stages]; a[i] = { ...st, shape: e.target.value }; updateStages(a) }}>
 <option value="taper">收窄段</option>
 <option value="rect">矩形段</option>
 </select>
 <input style={{ ...S.input, width: 70 }} type="number" step="0.1" value={st.widthRatio} disabled={!editing} onChange={e => { const a = [...stages]; a[i] = { ...st, widthRatio: parseFloat(e.target.value) || 1 }; updateStages(a) }} />
 {editing && <button style={S.delBtn} onClick={() => updateStages(stages.filter((_, j) => j !== i))}>×</button>}
 </div>
 ))}

 <div style={{ ...S.sectionTitle, marginTop: 20 }}><span>节点挂载配置（{markers.length}个）</span>{editing && <button style={S.addBtn} onClick={addMarker}>+ 添加节点</button>}</div>
 <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>phaseCode 必须来自已有节点模板，stage 必须来自上方主阶段。position 表示节点在所属主阶段中的相对位置，范围 0-1（0=阶段起点，0.5=阶段中点，1=阶段终点）。</div>
 {markers.map((m, i) => (
 <div key={i} style={{ ...S.row, gap: 6, flexWrap: 'wrap' as any }}>
 <select style={S.select} value={m.phaseCode} disabled={!editing} onChange={e => { const a = [...markers]; a[i] = { ...m, phaseCode: e.target.value }; updateMarkers(a) }}>
 <option value="">选择节点</option>
 {allPhases.map(p => <option key={p.phase_code} value={p.phase_code}>{p.phase_name || p.phase_code}</option>)}
 </select>
 <select style={S.select} value={m.stage} disabled={!editing} onChange={e => { const a = [...markers]; a[i] = { ...m, stage: e.target.value }; updateMarkers(a) }}>
 <option value="">选择阶段</option>
 {stages.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
 </select>
 <select style={S.select} value={m.side} disabled={!editing} onChange={e => { const a = [...markers]; a[i] = { ...m, side: e.target.value }; updateMarkers(a) }}>
 <option value="top">上方</option>
 <option value="bottom">下方</option>
 </select>
 <input style={{ ...S.input, width: 70 }} type="number" step="0.1" min="0" max="1" value={m.position} disabled={!editing} onChange={e => { const a = [...markers]; a[i] = { ...m, position: parseFloat(e.target.value) || 0 }; updateMarkers(a) }} />
 {editing && <button style={S.delBtn} onClick={() => updateMarkers(markers.filter((_, j) => j !== i))}>×</button>}
 </div>
 ))}
 </div>
 )
}

// ============================================================
// 决议规则配置（resolution_rule_config）
// DCP/TR 分别配置：发布人角色、提交要求、通过规则、可选决议结果
// ============================================================
const ALL_CONCLUSIONS = [
 { value: 'pass', label: '通过' },
 { value: 'conditional_pass', label: '有条件通过' },
 { value: 'reject', label: '❌ 驳回' },
 { value: 'fail', label: '不通过' },
 { value: 'rework', label: '返工' },
]

const ResolutionRuleConfig: React.FC<{ rules: any; roles: any[]; onChange: (v: any) => void; editing: boolean; reviewType: 'dcp' | 'tr' }> = ({ rules, roles, onChange, editing, reviewType }) => {
 const rule = rules[reviewType] || {
 publisher: { mode: 'single_role', role: '' },
 submitRequirement: { mode: 'must_vote_roles' },
 passRule: { mode: reviewType === 'tr' ? 'all_required_submitted' : 'min_approval_count', minCount: 3, excludeRoles: [], approvalConclusions: ['pass', 'conditional_pass'], rejectOnAnyVeto: reviewType === 'tr' },
 allowedConclusions: reviewType === 'tr' ? ['pass', 'conditional_pass', 'fail', 'rework'] : ['pass', 'conditional_pass', 'reject'],
 }
 const typeRoles = roles.filter((r: any) => (r.review_type || 'dcp') === reviewType)
 const typeLabel = reviewType === 'dcp' ? 'DCP 决策评审' : 'TR 技术评审'

 function update(path: string, value: any) {
 const newRule = JSON.parse(JSON.stringify(rule))
 const parts = path.split('.')
 let cur = newRule
 for (let i = 0; i < parts.length - 1; i++) {
   if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
   cur = cur[parts[i]]
 }
 cur[parts[parts.length - 1]] = value
 onChange({ ...rules, [reviewType]: newRule })
 }

 function toggleArrayItem(path: string, item: string) {
 const arr = path.split('.').reduce((obj: any, key) => obj[key], rule) as string[]
 const has = arr.includes(item)
 update(path, has ? arr.filter(x => x !== item) : [...arr, item])
 }

 const chipStyle = (sel: boolean): React.CSSProperties => ({
 display: 'inline-block', padding: '3px 10px', margin: '2px 4px 2px 0', borderRadius: 4, fontSize: 12,
 cursor: editing ? 'pointer' : 'default', border: `1px solid ${sel ? '#1677ff' : '#d9d9d9'}`,
 background: sel ? '#e6f4ff' : '#fafafa', color: sel ? '#1677ff' : '#666',
 })

 return (
 <div>
 <h3 style={{ ...S.sectionTitle, fontSize: 16 }}>{typeLabel} — 决议规则配置</h3>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 16 }}>
 配置 {reviewType.toUpperCase()} 评审的决议发布权限、提交要求、通过规则和可选决议结果。修改后需保存生效。
 </div>

 {/* 1. 决议角色（单选） */}
 <div style={{ marginBottom: 20, padding: 12, background: '#fafafa', borderRadius: 4 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>决议角色</div>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>
 每条评审单只能有 1 名决议人。这里选择决议角色；具体决议人由评审单中该角色对应的人员决定。
 </div>
 <div>
 {typeRoles.length === 0 && <span style={{ color: '#ff4d4f', fontSize: 12 }}>请先在「评审角色」中配置{reviewType.toUpperCase()}角色</span>}
 {typeRoles.map((r: any) => {
   const sel = (rule.publisher?.role || '') === r.role_name
   return (
   <span key={r.role_name} style={chipStyle(sel)}
   onClick={() => editing && update('publisher.role', sel ? '' : r.role_name)}>
   {r.role_name}{r.must_vote ? ' (必投)' : ''}{r.has_veto ? ' (否决)' : ''}
   </span>
   )
 })}
 </div>
 </div>

 {/* 2. 发布前提交要求 */}
 <div style={{ marginBottom: 20, padding: 12, background: '#fafafa', borderRadius: 4 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>发布前提交要求</div>
 <select style={S.select} value={rule.submitRequirement?.mode || 'must_vote_roles'} disabled={!editing}
   onChange={e => update('submitRequirement.mode', e.target.value)}>
   <option value="must_vote_roles">必投角色全部提交</option>
   <option value="all_reviewers">全部评审人提交</option>
   <option value="vote_scope_roles">计票范围内角色全部提交</option>
   <option value="publisher_only">仅要求发布人存在（不校验其他人）</option>
 </select>
 </div>

 {/* 3. 通过规则 */}
 <div style={{ marginBottom: 20, padding: 12, background: '#fafafa', borderRadius: 4 }}>
   <div style={{ fontWeight: 600, marginBottom: 8 }}>通过规则（最终决议为「通过」时的校验）</div>
   <select style={S.select} value={rule.passRule?.mode || 'min_approval_count'} disabled={!editing}
     onChange={e => update('passRule.mode', e.target.value)}>
     <option value="min_approval_count">至少 N 人通过/有条件通过</option>
     <option value="all_required_approved">必投角色全部通过/有条件通过</option>
     <option value="all_required_submitted">仅校验已提交（不强制通过数）</option>
   </select>
   {(rule.passRule?.mode || 'min_approval_count') === 'min_approval_count' && (
     <>
       <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
         <label style={{ fontSize: 12 }}>最少通过人数：</label>
         <input style={{ ...S.input, width: 80 }} type="number" min="1" value={rule.passRule?.minCount || 3} disabled={!editing}
           onChange={e => update('passRule.minCount', parseInt(e.target.value) || 3)} />
       </div>
       {/* 计票范围 */}
       <div style={{ marginTop: 8 }}>
         <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>计票范围：</label>
         <select style={S.select} value={rule.passRule?.voteScope?.mode || 'must_vote_roles'} disabled={!editing}
           onChange={e => update('passRule.voteScope.mode', e.target.value)}>
           <option value="must_vote_roles">仅必投角色</option>
           <option value="all_reviewers">所有评审人</option>
           <option value="selected_roles">指定角色</option>
         </select>
       </div>
       {/* 指定角色多选 */}
       {(rule.passRule?.voteScope?.mode || 'must_vote_roles') === 'selected_roles' && (
         <div style={{ marginTop: 8 }}>
           <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>指定计票角色：</label>
           <span>
             {typeRoles.map((r: any) => (
               <span key={r.role_name} style={chipStyle((rule.passRule?.voteScope?.selectedRoles || []).includes(r.role_name))}
                 onClick={() => editing && toggleArrayItem('passRule.voteScope.selectedRoles', r.role_name)}>{r.role_name}</span>
             ))}
           </span>
         </div>
       )}
       {/* 从计票范围中排除角色 */}
       <div style={{ marginTop: 8 }}>
         <label style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>从计票范围中排除以下角色：</label>
         <span>
           {typeRoles.map((r: any) => (
             <span key={r.role_name} style={chipStyle((rule.passRule?.voteScope?.excludeRoles || []).includes(r.role_name))}
               onClick={() => editing && toggleArrayItem('passRule.voteScope.excludeRoles', r.role_name)}>{r.role_name}</span>
           ))}
         </span>
       </div>
       {/* 实时可达性提示 */}
       {(() => {
         const mode = rule.passRule?.voteScope?.mode || 'must_vote_roles'
         const exclude = rule.passRule?.voteScope?.excludeRoles || []
         const selected = rule.passRule?.voteScope?.selectedRoles || []
         let scopeCount = 0
         if (mode === 'all_reviewers') scopeCount = typeRoles.length
         else if (mode === 'selected_roles') scopeCount = typeRoles.filter((r: any) => selected.includes(r.role_name)).length
         else scopeCount = typeRoles.filter((r: any) => r.must_vote).length
         scopeCount -= typeRoles.filter((r: any) => exclude.includes(r.role_name) && (mode === 'all_reviewers' || (mode === 'must_vote_roles' && r.must_vote) || (mode === 'selected_roles' && selected.includes(r.role_name)))).length
         const minCount = rule.passRule?.minCount || 3
         if (scopeCount <= 0) return <div style={{ marginTop: 6, fontSize: 12, color: '#ff4d4f' }}>⚠ 当前计票范围内没有可计票角色</div>
         if (minCount > scopeCount) return <div style={{ marginTop: 6, fontSize: 12, color: '#ff4d4f' }}>⚠ 当前计票范围内最多 {scopeCount} 个角色可计票，不能要求至少 {minCount} 人通过</div>
         return <div style={{ marginTop: 6, fontSize: 12, color: '#52c41a' }}>✓ 当前计票范围 {scopeCount} 个角色可计票，要求 ≥{minCount} 人通过</div>
       })()}
     </>
   )}
   <div style={{ marginTop: 8 }}>
     <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: editing ? 'pointer' : 'default' }}>
       <input type="checkbox" checked={!!rule.passRule?.rejectOnAnyVeto} disabled={!editing}
         onChange={e => update('passRule.rejectOnAnyVeto', e.target.checked)} />
       启用否决权角色一票否决（否决权角色投反对票时，不可决议为「通过」）
     </label>
   </div>
 </div>

 {/* 4. 可选决议结果 */}
 <div style={{ marginBottom: 20, padding: 12, background: '#fafafa', borderRadius: 4 }}>
 <div style={{ fontWeight: 600, marginBottom: 8 }}>🎯 可选最终决议结果</div>
 <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>
 勾选当前{reviewType.toUpperCase()}评审允许的最终决议结果。未勾选的选项不会在发布决议时显示。
 </div>
 <div>
 {ALL_CONCLUSIONS.map(c => (
 <span key={c.value} style={chipStyle((rule.allowedConclusions || []).includes(c.value))}
 onClick={() => editing && toggleArrayItem('allowedConclusions', c.value)}>{c.label}</span>
 ))}
 </div>
 </div>

 {/* 5. 决议门径硬约束（发布「通过」前的硬性校验） */}
 <div style={{ marginBottom: 20, padding: 12, background: '#fafafa', borderRadius: 4 }}>
   <div style={{ fontWeight: 600, marginBottom: 8 }}>🚦 决议门径硬约束</div>
   <div style={{ color: '#999', fontSize: 12, marginBottom: 8 }}>
     发布最终决议为「通过」前，强制校验指标红线、Checklist 完整、前置阶段有效。可设为「阻断通过」「警告放行」「不校验」。旧评审单无此配置时按默认（阻断）执行。
   </div>
   <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
     <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
       指标红线：
       <select style={S.select} value={rule.gatePolicy?.indicatorRedLine || 'block'} disabled={!editing}
         onChange={e => update('gatePolicy.indicatorRedLine', e.target.value)}>
         <option value="block">阻断通过</option>
         <option value="warn">警告放行</option>
         <option value="off">不校验</option>
       </select>
     </label>
     <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
       红线范围：
       <select style={S.select} value={rule.gatePolicy?.indicatorGateMode || 'red_only'} disabled={!editing}
         onChange={e => update('gatePolicy.indicatorGateMode', e.target.value)}>
         <option value="red_only">仅红线</option>
         <option value="red_and_yellow">红线+黄线</option>
       </select>
     </label>
   </div>
   <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginTop: 8 }}>
     <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
       Checklist：
       <select style={S.select} value={rule.gatePolicy?.checklistComplete || 'block'} disabled={!editing}
         onChange={e => update('gatePolicy.checklistComplete', e.target.value)}>
         <option value="block">阻断通过</option>
         <option value="warn">警告放行</option>
         <option value="off">不校验</option>
       </select>
     </label>
     <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
       Checklist 范围：
       <select style={S.select} value={rule.gatePolicy?.checklistScope || 'all'} disabled={!editing}
         onChange={e => update('gatePolicy.checklistScope', e.target.value)}>
         <option value="all">全部检查项</option>
         <option value="required_roles">仅必投/否决角色</option>
       </select>
     </label>
   </div>
   <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, marginTop: 8, cursor: editing ? 'pointer' : 'default' }}>
     <input type="checkbox" checked={rule.gatePolicy?.prerequisiteRecheck !== false} disabled={!editing}
       onChange={e => update('gatePolicy.prerequisiteRecheck', e.target.checked)} />
     发布「通过」前复查前置阶段决议仍有效（未撤回/否决）
   </label>
 </div>

 {!editing && (
 <div style={{ padding: '8px 12px', borderRadius: 4, fontSize: 12, background: '#f0f5ff', color: '#1677ff' }}>
 点击右上角「编辑」修改决议规则配置
 </div>
 )}
 </div>
 )
}

// ============================================================
// 评审人 Profile / 项目绑定面板
// ============================================================
type ProjectOption = { uuid: string; name: string; identifier: string }

function shouldDropUp(element: HTMLElement | null, estimatedHeight: number): boolean {
  if (!element || typeof window === 'undefined') return false
  const rect = element.getBoundingClientRect()
  return window.innerHeight - rect.bottom < estimatedHeight + 16 && rect.top > estimatedHeight + 16
}

const ReviewerProfilesPanel: React.FC<{
  profiles: any[]
  projectBindings: any[]
  roles: any[]
  reviewType: string
  onRefresh: () => Promise<void>
}> = ({ profiles, projectBindings, roles, reviewType, onRefresh }) => {
  type Assignment = { mode: 'single' | 'pool'; default_reviewer_uuid: string; candidate_uuids: string[] }
  const [editingProfile, setEditingProfile] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [profileForm, setProfileForm] = useState<{ profile_name: string; description: string; assignments: Record<string, Assignment> }>({
    profile_name: '',
    description: '',
    assignments: {},
  })
  const [members, setMembers] = useState<{ uuid: string; name: string; email: string }[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [bindingProfile, setBindingProfile] = useState<any>(null)
  const [selectedProjectUuids, setSelectedProjectUuids] = useState<string[]>([])
  const [bindingSaving, setBindingSaving] = useState(false)

  useEffect(() => {
    const tu = getTeamUUID()
    if (!tu) return
    void fetch(`/project/api/project/team/${tu}/members?limit=500`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list = data?.members || data?.data || []
        setMembers((Array.isArray(list) ? list : []).map((u: any) => ({
          uuid: u.uuid || '',
          name: u.name || u.email || '未知成员',
          email: u.email || '',
        })).filter((u: any) => u.uuid))
      })
      .catch(() => {})
    void fetch(`/project/api/project/team/${tu}/items/graphql?t=dcp_projects`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ buckets(groupBy: { projects: {} }, pagination: { limit: 100, after: "", preciseCount: true }) { projects(limit: 10000, filterGroup: [{ visibleInProject_equal: true, isArchive_equal: false }]) { uuid identifier name key } } }`,
        variables: {},
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const buckets = data?.data?.data?.buckets || data?.data?.buckets || data?.buckets || []
        const list = (Array.isArray(buckets) ? buckets : []).flatMap((b: any) => Array.isArray(b?.projects) ? b.projects : [])
        const byUuid = new Map<string, ProjectOption>()
        list.forEach((p: any) => {
          const uuid = p?.uuid || ''
          if (uuid) byUuid.set(uuid, { uuid, name: p?.name || p?.identifier || '未命名项目', identifier: p?.identifier || p?.key || '' })
        })
        setProjects([...byUuid.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
      })
      .catch(() => {})
  }, [])

  function emptyAssignments(): Record<string, Assignment> {
    const out: Record<string, Assignment> = {}
    for (const role of roles) {
      out[role.role_name] = { mode: role.must_vote || role.has_veto ? 'single' : 'pool', default_reviewer_uuid: '', candidate_uuids: [] }
    }
    return out
  }

  function loadAssignments(profile: any): Record<string, Assignment> {
    const raw = jsonArrObj(profile.role_assignments_json || profile.reviewers_json || '[]')
    const out = emptyAssignments()
    for (const item of raw) {
      if (!item?.role_name) continue
      out[item.role_name] = {
        mode: item.mode === 'pool' ? 'pool' : 'single',
        default_reviewer_uuid: item.default_reviewer_uuid || item.default_reviewer || item.reviewer_uuid || '',
        candidate_uuids: Array.isArray(item.candidate_uuids) ? item.candidate_uuids.filter(Boolean) : (item.candidate_uuids_json ? jsonArr(item.candidate_uuids_json) : []),
      }
    }
    return out
  }

  function startCreate() {
    setProfileForm({ profile_name: '', description: '', assignments: emptyAssignments() })
    setEditingProfile({ _key: 'new' })
    setMsg('')
  }

  function startEdit(profile: any) {
    setProfileForm({
      profile_name: profile.profile_name || '',
      description: profile.description || '',
      assignments: loadAssignments(profile),
    })
    setEditingProfile(profile)
    setMsg('')
  }

  function updateAssignment(roleName: string, patch: Partial<Assignment>) {
    setProfileForm(prev => {
      const current = prev.assignments[roleName] || {
        mode: 'single' as const,
        default_reviewer_uuid: '',
        candidate_uuids: [],
      }
      return {
        ...prev,
        assignments: {
          ...prev.assignments,
          [roleName]: { ...current, ...patch },
        },
      }
    })
  }

  function toggleCandidate(roleName: string, uuid: string) {
    const cur = profileForm.assignments[roleName]?.candidate_uuids || []
    const next = cur.includes(uuid) ? cur.filter(v => v !== uuid) : [...cur, uuid]
    updateAssignment(roleName, { candidate_uuids: next })
  }

  async function handleSaveProfile() {
    if (!profileForm.profile_name.trim()) {
      setMsg('请输入 Profile 名称')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      const tu = getTeamUUID()
      const role_assignments = roles.map((role: any) => {
        const a = profileForm.assignments[role.role_name] || { mode: 'single', default_reviewer_uuid: '', candidate_uuids: [] }
        return {
          role_name: role.role_name,
          mode: a.mode,
          default_reviewer_uuid: a.mode === 'single' ? a.default_reviewer_uuid : '',
          candidate_uuids: a.mode === 'pool' ? a.candidate_uuids : [],
        }
      })
      const body = {
        profile_name: profileForm.profile_name.trim(),
        review_type: reviewType,
        description: profileForm.description.trim(),
        role_assignments,
      }
      const url = editingProfile._key === 'new'
        ? `/project/api/project/team/${tu}/dcp/reviewer-profile`
        : `/project/api/project/team/${tu}/dcp/reviewer-profile/${editingProfile._key}`
      const method = editingProfile._key === 'new' ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Ones-Plugin-Id': '709xehle' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      const ret = data.body || data
      if (ret.error) {
        setMsg('保存失败: ' + ret.error)
        return
      }
      setEditingProfile(null)
      onRefresh()
      setMsg('Profile 已保存')
    } catch (err: any) {
      setMsg('保存失败: ' + (err?.message || err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(pid: string) {
    if (!confirm('确定删除此 Profile？')) return
    try {
      const tu = getTeamUUID()
      const res = await fetch(`/project/api/project/team/${tu}/dcp/reviewer-profile/${pid}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Ones-Plugin-Id': '709xehle' },
      })
      const data = await res.json()
      const body = data.body || data
      if (body.error) {
        setMsg('删除失败: ' + body.error)
        return
      }
      setEditingProfile(null)
      onRefresh()
      setMsg('Profile 已删除')
    } catch (err: any) {
      setMsg('删除失败: ' + (err?.message || err))
    }
  }

  function startBinding(profile: any) {
    const bound = projectBindings.filter(b => b.profile_id === profile._key).map(b => b.project_uuid).filter(Boolean)
    setBindingProfile(profile)
    setSelectedProjectUuids(bound)
    setMsg('')
  }

  async function handleSaveBindings() {
    if (!bindingProfile) return
    if (selectedProjectUuids.length === 0) {
      if (!confirm('当前未选择项目，将解除该 Profile 的全部项目绑定，是否继续？')) return
    }
    setBindingSaving(true)
    setMsg('')
    try {
      const current = projectBindings.filter(b => b.profile_id === bindingProfile._key)
      const currentByProject = new Map(current.map(b => [b.project_uuid, b]))
      const selected = new Set(selectedProjectUuids)
      for (const projectUUID of selected) {
        if (!currentByProject.has(projectUUID)) {
          await upsertProjectBinding({ project_uuid: projectUUID, profile_id: bindingProfile._key, review_type: reviewType })
        }
      }
      for (const binding of current) {
        if (!selected.has(binding.project_uuid)) await deleteProjectBinding(binding._key)
      }
      await onRefresh()
      setBindingProfile(null)
      setMsg(`Profile「${bindingProfile.profile_name}」的项目绑定已保存`)
    } catch (err: any) {
      setMsg('绑定失败: ' + (err?.message || err))
    } finally {
      setBindingSaving(false)
    }
  }

  if (!editingProfile) {
    return (
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#262626', marginBottom: 6 }}>评审人 Profile（{reviewType === 'dcp' ? 'DCP' : 'TR'}）</div>
            <div style={{ color: '#8c8c8c', fontSize: 12, lineHeight: 1.6 }}>Profile 统一定义各评审角色的默认人选或候选范围，可复用到多个项目。</div>
          </div>
          <button style={{ ...S.btn(true), whiteSpace: 'nowrap' }} onClick={startCreate}>+  新建 Profile</button>
        </div>
        {msg && <div style={{ padding: '8px 12px', borderRadius: 4, fontSize: 12, marginBottom: 12, background: msg.includes('失败') ? '#fff2f0' : '#f6ffed', color: msg.includes('失败') ? '#cf1322' : '#52c41a' }}>{msg}</div>}
        {profiles.length === 0 ? (
          <div style={{ ...S.card, padding: '44px 24px', textAlign: 'center', color: '#8c8c8c' }}>
            暂无评审人 Profile，请先新建一套评审人配置。
          </div>
        ) : (
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>名称</th>
              <th style={S.th}>描述</th>
              <th style={S.th}>角色分配</th>
              <th style={S.th}>更新日期</th>
              <th style={{ ...S.th, width: 120 }}>操作</th>
            </tr></thead>
            <tbody>
              {profiles.map((p: any) => {
                const assigns = jsonArrObj(p.role_assignments_json || p.reviewers_json || '[]')
                return (
                  <tr key={p._key}>
                    <td style={S.td}><strong>{p.profile_name}</strong></td>
                    <td style={S.td}>{p.description || '-'}</td>
                    <td style={S.td}>{assigns.length} 个角色</td>
                    <td style={S.td}>{p.updated_at ? new Date(p.updated_at).toLocaleDateString('zh-CN') : '-'}</td>
                    <td style={S.td}>
                      <button style={{ ...S.btn(false), padding: '4px 12px', marginRight: 6 }} onClick={() => startEdit(p)}>编辑</button>
                      <button style={S.delBtn} onClick={() => handleDelete(p._key)}>删除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 32 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 5 }}>应用到项目</div>
            <div style={{ color: '#8c8c8c', fontSize: 12 }}>从 Profile 选择要复用这套评审人配置的项目，保存后会立即显示在对应 Profile 下。</div>
          </div>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>Profile</th>
              <th style={S.th}>已应用项目</th>
              <th style={{ ...S.th, width: 150 }}>操作</th>
            </tr></thead>
            <tbody>
              {profiles.map((profile: any) => {
                const bindings = projectBindings.filter(b => b.profile_id === profile._key)
                const names = bindings.map(b => projects.find(p => p.uuid === b.project_uuid)?.name || b.project_name || b.project_identifier || b.project_uuid).filter(Boolean)
                return (
                  <tr key={`binding-${profile._key}`}>
                    <td style={S.td}><strong>{profile.profile_name}</strong><div style={{ color: '#999', fontSize: 11, marginTop: 3 }}>{(profile.review_type || reviewType).toUpperCase()}</div></td>
                    <td style={S.td}>{names.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{names.map((name: string, i: number) => <span key={`${name}-${i}`} style={{ padding: '3px 8px', borderRadius: 4, background: '#f0f5ff', color: '#1677ff', fontSize: 12 }}>{name}</span>)}</div> : <span style={{ color: '#999' }}>尚未应用到项目</span>}</td>
                    <td style={S.td}><button style={{ ...S.btn(false), padding: '5px 12px' }} onClick={() => startBinding(profile)}>配置项目</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {bindingProfile && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onMouseDown={e => { if (e.target === e.currentTarget && !bindingSaving) setBindingProfile(null) }}>
            <div style={{ ...S.card, width: 'min(680px, 100%)', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>配置项目：{bindingProfile.profile_name}</div>
                <button title="关闭" style={{ border: 'none', background: 'transparent', fontSize: 20, color: '#999', cursor: 'pointer' }} onClick={() => !bindingSaving && setBindingProfile(null)}>×</button>
              </div>
              <ProjectMultiPicker projects={projects} selected={selectedProjectUuids} onChange={setSelectedProjectUuids} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                <button style={S.btn(false)} disabled={bindingSaving} onClick={() => setBindingProfile(null)}>取消</button>
                <button style={S.btn(true, bindingSaving)} disabled={bindingSaving} onClick={handleSaveBindings}>{bindingSaving ? '保存中…' : '保存绑定'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{editingProfile._key === 'new' ? '新建 Profile' : `编辑 Profile：${editingProfile.profile_name}`}</div>
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>为每个评审角色设置固定默认人选，或者限制可选的候选人范围。</div>
        </div>
        <button style={S.btn(false)} onClick={() => setEditingProfile(null)}>返回列表</button>
      </div>
      {msg && <div style={{ padding: '8px 12px', borderRadius: 4, fontSize: 12, marginBottom: 12, background: msg.includes('失败') ? '#fff2f0' : '#f6ffed', color: msg.includes('失败') ? '#cf1322' : '#52c41a' }}>{msg}</div>}
      <div style={{ ...S.card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 18 }}>
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>Profile 名称 <span style={{ color: '#ff4d4f' }}>*</span></label>
          <input style={{ ...S.input, height: 34 }} value={profileForm.profile_name} onChange={e => setProfileForm({ ...profileForm, profile_name: e.target.value })} placeholder="如：DCP 标准评审团" />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 6, fontWeight: 500 }}>描述</label>
          <input style={{ ...S.input, height: 34 }} value={profileForm.description} onChange={e => setProfileForm({ ...profileForm, description: e.target.value })} placeholder="说明这套 Profile 的适用场景" />
        </div>
      </div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>角色分配</div>
          <div style={{ color: '#8c8c8c', fontSize: 12 }}>单人默认会自动带入并锁定人选；候选池允许发起人从预设范围中选择。</div>
        </div>
        <table style={S.table}>
          <thead><tr>
            <th style={{ ...S.th, width: 190 }}>角色</th>
            <th style={{ ...S.th, width: 150 }}>模式</th>
            <th style={S.th}>默认值 / 候选池</th>
          </tr></thead>
          <tbody>
            {roles.map((role: any, roleIndex: number) => {
              const ass = profileForm.assignments[role.role_name] || { mode: 'single', default_reviewer_uuid: '', candidate_uuids: [] }
              const isSingle = ass.mode !== 'pool'
              return (
                <tr key={role.role_name}>
                  <td style={S.td}>
                    {role.role_name}
                    {role.must_vote && <span style={{ display: 'inline-block', marginLeft: 8, padding: '1px 6px', borderRadius: 3, fontSize: 11, background: '#fff7e6', color: '#faad14' }}>必投</span>}
                    {role.has_veto && <span style={{ display: 'inline-block', marginLeft: 4, padding: '1px 6px', borderRadius: 3, fontSize: 11, background: '#fff1f0', color: '#ff4d4f' }}>否决</span>}
                  </td>
                  <td style={S.td}>
                    <select style={{ ...S.select, width: '100%', height: 34 }} value={ass.mode} onChange={e => updateAssignment(role.role_name, { mode: e.target.value as 'single' | 'pool' })}>
                      <option value="single">单人默认</option>
                      <option value="pool">候选池</option>
                    </select>
                  </td>
                  <td style={S.td}>
                    {isSingle ? (
                      <UserPicker
                        members={members}
                        value={ass.default_reviewer_uuid}
                        displayName={members.find(m => m.uuid === ass.default_reviewer_uuid)?.name}
                        onChange={u => updateAssignment(role.role_name, { default_reviewer_uuid: u.uuid })}
                        placeholder="搜索默认评审人…"
                        allowedUserIds={members.map(m => m.uuid)}
                        forceDropUp={roleIndex >= Math.max(0, roles.length - 2)}
                      />
                    ) : (
                      <CandidatePoolPicker
                        selected={ass.candidate_uuids}
                        members={members}
                        onToggle={uid => toggleCandidate(role.role_name, uid)}
                        forceDropUp={roleIndex >= Math.max(0, roles.length - 2)}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 10, paddingTop: 2 }}>
        <button style={S.btn(true, saving)} disabled={saving} onClick={handleSaveProfile}>{saving ? '保存中…' : '保存 Profile'}</button>
        <button style={S.btn(false)} onClick={() => setEditingProfile(null)}>取消</button>
      </div>
    </div>
  )
}

const SelectedMemberChip: React.FC<{
  name: string
  onClear: () => void
  title?: string
}> = ({ name, onClear, title = '清除' }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, background: '#e6f4ff', padding: '2px 10px', borderRadius: 4 }}>
    {name}
    <button
      type="button"
      onClick={onClear}
      aria-label={title}
      title={title}
      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#ff4d4f', fontSize: 16, padding: 0, lineHeight: 1 }}
    >×</button>
  </span>
)

const CandidatePoolPicker: React.FC<{
  selected: string[]
  members: { uuid: string; name: string; email: string }[]
  onToggle: (uid: string) => void
  forceDropUp?: boolean
}> = ({ selected, members, onToggle, forceDropUp = false }) => {
  const selectedUuids = Array.isArray(selected) ? selected : []
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const keyword = query.trim().toLowerCase()
  const filtered = keyword
    ? members.filter(m => !selectedUuids.includes(m.uuid) && (m.name.toLowerCase().includes(keyword) || m.email.toLowerCase().includes(keyword))).slice(0, 30)
    : []

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {selectedUuids.length === 0 ? <span style={{ color: '#999', fontSize: 12 }}>尚未选择候选人</span> : selectedUuids.map(uid => {
          const m = members.find(x => x.uuid === uid)
          return (
            <SelectedMemberChip key={uid} name={m?.name || '未知成员'} title="移除候选人" onClear={() => onToggle(uid)} />
          )
        })}
      </div>
      <input
        style={{ ...S.input, height: 34 }}
        value={query}
        onFocus={() => { if (query.trim()) { setDropUp(forceDropUp || shouldDropUp(ref.current, 220)); setOpen(true) } }}
        onChange={e => { setQuery(e.target.value); setDropUp(forceDropUp || shouldDropUp(ref.current, 220)); setOpen(!!e.target.value.trim()) }}
        placeholder="搜索姓名或邮箱添加候选人"
      />
      {open && keyword && (
        <div style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, maxHeight: 220, overflow: 'auto', border: '1px solid #d9d9d9', borderRadius: 4, marginTop: dropUp ? 0 : 4, marginBottom: dropUp ? 4 : 0, top: dropUp ? 'auto' : '100%', bottom: dropUp ? 'calc(100% + 4px)' : 'auto', background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,0.12)' }}>
          {filtered.length === 0 ? <div style={{ padding: '10px 12px', color: '#999' }}>无匹配成员</div> : filtered.map(m => (
            <div
              key={m.uuid}
              onMouseDown={e => {
                e.preventDefault()
                onToggle(m.uuid)
                setQuery('')
                setOpen(false)
              }}
              style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid #f5f5f5' }}
            >
              <div style={{ fontWeight: 500 }}>{m.name}</div>
              {m.email && <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>{m.email}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ProjectMultiPicker: React.FC<{
  projects: ProjectOption[]
  selected: string[]
  onChange: (uuids: string[]) => void
}> = ({ projects, selected, onChange }) => {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const keyword = query.trim().toLowerCase()
  const filtered = projects.filter(p => {
    if (selected.includes(p.uuid)) return false
    if (!keyword) return true
    return p.name.toLowerCase().includes(keyword) || p.identifier.toLowerCase().includes(keyword)
  }).slice(0, 50)

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ minHeight: 34, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: selected.length ? '5px 8px' : '0 8px', border: '1px solid #d9d9d9', borderRadius: 4, background: '#fff' }}>
        {selected.map(uuid => {
          const project = projects.find(p => p.uuid === uuid)
          return (
            <span key={uuid} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 7px', borderRadius: 4, background: '#f0f5ff', color: '#1677ff', fontSize: 12 }}>
              {project?.name || '未知项目'}
              <button type="button" title="移除项目" onClick={() => onChange(selected.filter(id => id !== uuid))} style={{ border: 'none', padding: 0, background: 'transparent', color: '#1677ff', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </span>
          )
        })}
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          placeholder={selected.length ? '继续搜索项目' : '搜索项目名称'}
          style={{ flex: '1 1 180px', minWidth: 160, height: 30, padding: 0, border: 'none', outline: 'none', fontSize: 13 }}
        />
      </div>
      {open && (
        <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, maxHeight: 260, overflow: 'auto', marginTop: 4, border: '1px solid #d9d9d9', borderRadius: 4, background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,0.12)' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', color: '#999' }}>{projects.length === 0 ? '项目列表加载中或暂无可选项目' : '无匹配项目'}</div>
          ) : filtered.map(project => (
            <div
              key={project.uuid}
              onMouseDown={e => {
                e.preventDefault()
                onChange([...selected, project.uuid])
                setQuery('')
                setOpen(false)
              }}
              style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid #f5f5f5' }}
            >
              <div style={{ fontWeight: 500 }}>{project.name}</div>
              {project.identifier && <div style={{ color: '#999', fontSize: 11, marginTop: 2 }}>{project.identifier}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const UserPicker: React.FC<{
  value: string
  onChange: (user: { uuid: string; name: string }) => void
  placeholder?: string
  displayName?: string
  allowedUserIds?: string[]
  members: { uuid: string; name: string; email: string }[]
  forceDropUp?: boolean
}> = ({ value, onChange, placeholder = '搜索用户姓名或邮箱…', displayName, allowedUserIds, members, forceDropUp = false }) => {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ uuid: string; name: string; email: string }[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const timerRef = React.useRef<any>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const allowedSet = React.useMemo(() => allowedUserIds && allowedUserIds.length > 0 ? new Set(allowedUserIds) : null, [allowedUserIds])
  const shownName = value ? (displayName || members.find(m => m.uuid === value)?.name || '') : ''

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function search(kw: string) {
    const keyword = kw.trim().toLowerCase()
    if (!keyword) {
      setResults([])
      setOpen(false)
      setLoading(false)
      return
    }
    const base = allowedSet ? members.filter(m => allowedSet.has(m.uuid)) : members
    setLoading(true)
    const next = base.filter(m => m.name.toLowerCase().includes(keyword) || m.email.toLowerCase().includes(keyword)).slice(0, 20)
    setResults(next)
    setOpen(true)
    setLoading(false)
  }

  function handleChange(next: string) {
    setQuery(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => search(next), 200)
  }

  function handleClear() {
    onChange({ uuid: '', name: '' })
    setQuery('')
    setResults([])
    setOpen(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (shownName) {
    return (
      <SelectedMemberChip name={shownName} onClear={handleClear} />
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        style={S.input}
        value={query}
        onChange={e => { handleChange(e.target.value); setDropUp(forceDropUp || shouldDropUp(ref.current, 220)) }}
        onFocus={() => { if (query.trim()) { setDropUp(forceDropUp || shouldDropUp(ref.current, 220)); setOpen(true) } }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
      />
      {loading && <div style={{ position: 'absolute', right: 10, top: 7, fontSize: 12, color: '#999' }}>搜索中…</div>}
      {open && results.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, maxHeight: 220, overflow: 'auto', top: dropUp ? 'auto' : '100%', bottom: dropUp ? 'calc(100% + 4px)' : 'auto', background: '#fff', border: '1px solid #d9d9d9', borderRadius: 4, marginTop: dropUp ? 0 : 4, marginBottom: dropUp ? 4 : 0, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
          {results.map(m => (
            <div
              key={m.uuid}
              onMouseDown={e => {
                e.preventDefault()
                onChange({ uuid: m.uuid, name: m.name })
                setQuery('')
                setResults([])
                setOpen(false)
              }}
              style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f5f5' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span>{m.name}</span>
              {m.email && <span style={{ fontSize: 11, color: '#999' }}>{m.email}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

ReactDOM.render(<App />, document.getElementById('ones-mf-root'))

export { App as ConfigPage }
