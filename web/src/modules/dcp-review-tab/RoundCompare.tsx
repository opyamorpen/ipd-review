import React, { useState, useEffect } from 'react'
import * as api from './api'

const RISK_COLORS: Record<string, string> = { green: '#52c41a', yellow: '#faad14', red: '#ff4d4f' }
const RISK_LABELS: Record<string, string> = { green: '达标', yellow: '风险', red: '不达标' }
const CONCLUSION_LABELS: Record<string, string> = { pass: '通过', conditional_pass: '有条件通过', reject: '否决', fail: '不通过', rework: '返工' }

function parseVotes(res: any): { indicators: any[]; materials: any[] } {
  if (!res) return { indicators: [], materials: [] }
  let v = res.based_on_votes
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = {} } }
  if (!v || typeof v !== 'object') v = {}
  return { indicators: v.indicators || [], materials: v.materials || [] }
}

export const RoundCompare: React.FC<{ reviewUuid: string; currentRoundNo: number; currentData: any }> = ({ reviewUuid, currentRoundNo, currentData }) => {
  const [rounds, setRounds] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selA, setSelA] = useState<number>(0)
  const [selB, setSelB] = useState<number>(0)

  useEffect(() => {
    let mounted = true
    api.getReviewRounds(reviewUuid).then((resp: any) => {
      if (!mounted) return
      const allRounds: any[] = []
      // 历史轮次（有决议快照）
      for (const r of (resp.rounds || [])) {
        const { indicators, materials } = parseVotes(r.resolution)
        allRounds.push({
          round_no: r.round_no,
          label: `第${r.round_no}轮`,
          conclusion: r.resolution?.final_conclusion || '',
          published_at: r.resolution?.published_at || 0,
          indicators, materials,
          is_current: r.round_no === currentRoundNo,
          has_resolution: !!r.resolution,
        })
      }
      // 当前轮次（可能未发布决议，用实时数据补充）
      const hasCurrent = allRounds.some(r => r.round_no === currentRoundNo)
      if (!hasCurrent) {
        allRounds.push({
          round_no: currentRoundNo,
          label: `第${currentRoundNo}轮（进行中）`,
          conclusion: '',
          published_at: 0,
          indicators: (currentData.indicators || []).map((ind: any) => ({
            indicator_name: ind.indicator_name || ind.template?.indicator_name || '',
            current_value: ind.current_value || 0,
            risk_color: ind.risk_color || 'green',
            notes: ind.notes || '',
          })),
          materials: (currentData.materials || []).map((m: any) => ({
            template_id: m.template_id,
            material_name: m.material_name || m.template?.material_name || '',
            required: m.required ?? (m.template?.required ? 1 : 0),
            file_name: m.file_name || '',
            file_size: m.file_size || 0,
            uploaded_at: m.uploaded_at || 0,
          })),
          is_current: true,
          has_resolution: false,
        })
      }
      allRounds.sort((a, b) => a.round_no - b.round_no)
      setRounds(allRounds)
      // 默认选最近两轮
      if (allRounds.length >= 2) {
        setSelA(allRounds.length - 2)
        setSelB(allRounds.length - 1)
      }
    }).catch(() => {}).finally(() => mounted && setLoading(false))
    return () => { mounted = false }
  }, [reviewUuid, currentRoundNo])

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>加载轮次数据...</div>
  if (rounds.length < 2) return <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>当前仅 {rounds.length} 轮评审，无对比数据。</div>

  const roundA = rounds[selA]
  const roundB = rounds[selB]

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#666' }}>对比：</span>
        <select value={selA} onChange={e => setSelA(Number(e.target.value))} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13 }}>
          {rounds.map((r, i) => <option key={i} value={i}>{r.label}{r.has_resolution ? `（${CONCLUSION_LABELS[r.conclusion] || r.conclusion}）` : '（进行中）'}</option>)}
        </select>
        <span style={{ color: '#999' }}>→</span>
        <select value={selB} onChange={e => setSelB(Number(e.target.value))} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13 }}>
          {rounds.map((r, i) => <option key={i} value={i}>{r.label}{r.has_resolution ? `（${CONCLUSION_LABELS[r.conclusion] || r.conclusion}）` : '（进行中）'}</option>)}
        </select>
      </div>
      <IndicatorCompare roundA={roundA} roundB={roundB} />
      <MaterialCompare roundA={roundA} roundB={roundB} />
    </div>
  )
}

// 指标对比表
const IndicatorCompare: React.FC<{ roundA: any; roundB: any }> = ({ roundA, roundB }) => {
  const indsA = roundA?.indicators || []
  const indsB = roundB?.indicators || []
  // 合并去重，以 indicator_name 为主键
  const names: string[] = []
  for (const ind of [...indsA, ...indsB]) {
    const n = ind.indicator_name || '未命名指标'
    if (!names.includes(n)) names.push(n)
  }
  if (names.length === 0) return null

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#333' }}>指标对比</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={S.th}>指标名称</th>
            <th style={S.th}>{roundA.label}</th>
            <th style={S.th}>{roundB.label}</th>
            <th style={S.th}>变化趋势</th>
          </tr>
        </thead>
        <tbody>
          {names.map(name => {
            const a = indsA.find((i: any) => (i.indicator_name || '未命名指标') === name)
            const b = indsB.find((i: any) => (i.indicator_name || '未命名指标') === name)
            return (
              <tr key={name}>
                <td style={S.td}>{name}</td>
                <td style={S.td}>{a ? renderIndicatorCell(a) : <span style={{ color: '#ccc' }}>—</span>}</td>
                <td style={S.td}>{b ? renderIndicatorCell(b) : <span style={{ color: '#ccc' }}>—</span>}</td>
                <td style={S.td}>{renderTrend(a, b)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function renderIndicatorCell(ind: any): React.ReactNode {
  const color = RISK_COLORS[ind.risk_color || 'green'] || '#999'
  const label = RISK_LABELS[ind.risk_color || 'green'] || ''
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontWeight: 600 }}>{ind.current_value ?? 0}</span>
      <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 11, background: `${color}1a`, color, fontWeight: 600 }}>{label}</span>
    </span>
  )
}

function renderTrend(a: any, b: any): React.ReactNode {
  if (!a || !b) return <span style={{ color: '#ccc' }}>—</span>
  const ra = a.risk_color || 'green'
  const rb = b.risk_color || 'green'
  const rank = { green: 0, yellow: 1, red: 2 }
  const diff = (rank[ra as keyof typeof rank] ?? 0) - (rank[rb as keyof typeof rank] ?? 0)
  if (diff > 0) return <span style={{ color: '#52c41a', fontWeight: 600 }}>↓ 改善</span>
  if (diff < 0) return <span style={{ color: '#ff4d4f', fontWeight: 600 }}>↑ 恶化</span>
  return <span style={{ color: '#999' }}>→ 持平</span>
}

const S = {
  th: { padding: '8px 12px', textAlign: 'left' as const, background: '#fafafa', borderBottom: '1px solid #e8e8e8', fontSize: 12, color: '#666' },
  td: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13 },
}

// 材料对比表
const MaterialCompare: React.FC<{ roundA: any; roundB: any }> = ({ roundA, roundB }) => {
  const matsA = roundA?.materials || []
  const matsB = roundB?.materials || []
  // 合并去重，以 template_id 为主键，回退 material_name
  const keys: string[] = []
  const keyOf = (m: any) => m.template_id || m.material_name || m.file_name || ''
  for (const m of [...matsA, ...matsB]) {
    const k = keyOf(m)
    if (k && !keys.includes(k)) keys.push(k)
  }
  if (keys.length === 0) return null

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#333' }}>材料对比</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={S.th}>材料名称</th>
            <th style={S.th}>{roundA.label}</th>
            <th style={S.th}>{roundB.label}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(k => {
            const a = matsA.find((m: any) => keyOf(m) === k)
            const b = matsB.find((m: any) => keyOf(m) === k)
            const name = (b?.material_name || a?.material_name || '未命名材料')
            const required = (b?.required ?? a?.required ?? 0)
            return (
              <tr key={k}>
                <td style={S.td}>
                  {name}
                  {required ? <span style={{ color: '#ff4d4f', marginLeft: 4, fontSize: 11 }}>*</span> : null}
                </td>
                <td style={S.td}>{renderMaterialCell(a)}</td>
                <td style={S.td}>{renderMaterialCell(b, a)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function renderMaterialCell(m: any, prev?: any): React.ReactNode {
  if (!m) return <span style={{ color: '#ccc' }}>—</span>
  if (!m.file_name && !m.file_size) {
    return <span style={{ color: '#ff4d4f', fontSize: 12 }}>未上传</span>
  }
  const sizeKB = m.file_size ? (m.file_size > 1048576 ? `${(m.file_size / 1048576).toFixed(1)}MB` : `${(m.file_size / 1024).toFixed(0)}KB`) : ''
  // 对比上一轮：文件名变化=更新，之前缺失=新增
  let badge: React.ReactNode = null
  if (prev) {
    if (!prev.file_name && m.file_name) {
      badge = <span style={{ color: '#52c41a', fontSize: 11, marginLeft: 4 }}>新增</span>
    } else if (prev.file_name && m.file_name && prev.file_name !== m.file_name) {
      badge = <span style={{ color: '#1677ff', fontSize: 11, marginLeft: 4 }}>已更新</span>
    }
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <span style={{ color: '#52c41a' }}>&#10003;</span>
      <span>{m.file_name}</span>
      {sizeKB && <span style={{ color: '#999', fontSize: 11 }}>({sizeKB})</span>}
      {badge}
    </span>
  )
}
