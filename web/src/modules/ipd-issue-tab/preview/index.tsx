// ============================================================
// IPD评审 — 工作项详情「评审过程」Tab 的视图配置预览
// （Preview 插槽与具体工作项无关，仅展示布局占位）
// ============================================================
import React from 'react'
import ReactDOM from 'react-dom'
import { ConfigProvider } from '@ones-design/core'
import { OPProvider } from '@ones-op/bridge'
import { useProps } from '@ones-op/sdk'

const Preview: React.FC = () => {
  const props = (useProps('ones:issue:tab:new', 'Preview') || {}) as any
  return (
    <div style={{ padding: 12, fontSize: 13, color: '#4e5969' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>IPD评审 · 评审过程</div>
      <div style={{ fontSize: 12, lineHeight: '22px' }}>
        在工作项详情中展示：评审人与意见 · 材料与指标 · Checklist · 决议快照 · 状态轨迹
        {props?.viewMode ? `（${props.viewMode === 'wide' ? '宽屏' : '窄屏'}布局）` : ''}
      </div>
    </div>
  )
}

const App: React.FC = () => (
  <ConfigProvider>
    <OPProvider>
      <Preview />
    </OPProvider>
  </ConfigProvider>
)

ReactDOM.render(<App />, document.getElementById('ones-mf-root'))
