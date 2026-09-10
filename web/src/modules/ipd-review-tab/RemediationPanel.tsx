import React from 'react'
import { getTeamUUID } from '../../api'

const S = {
  card: { background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #e8e8e8', marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 600, marginBottom: 12 },
  input: { padding: '4px 8px', borderRadius: 4, border: '1px solid #d9d9d9', fontSize: 13, width: '100%', boxSizing: 'border-box' as any },
  btn: (p: boolean, d = false) => ({ padding: '6px 16px', borderRadius: 4, border: 'none', cursor: d ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500, background: p ? '#1677ff' : '#f0f0f0', color: p ? '#fff' : '#333', opacity: d ? 0.6 : 1 }),
  td: { padding: '6px 10px', borderBottom: '1px solid #f0f0f0', fontSize: 13 },
  th: { padding: '8px 10px', borderBottom: '2px solid #e8e8e8', fontSize: 12, color: '#666', fontWeight: 600, textAlign: 'left' as any },
  table: { width: '100%', borderCollapse: 'collapse' as any },
  tableWrap: { overflowX: 'auto' as any },
}

const STATUS_LABELS: Record<string, string> = {}
const STATUS_COLORS: Record<string, string> = {}

export const RemediationPanel: React.FC<{
  data: any
  effState: string
  currentUser: { uuid: string; name: string }
  isCreator: boolean
  isPublisher: boolean
  remediationIssueType: string
  remediationTypeStatus: 'loading' | 'available' | 'missing' | 'unknown' | 'unconfigured'
  remediationTypeMessage: string
  projectUuid: string
  remediationMsg: string
  remediationRefreshing: boolean
  remediationConfirming: boolean
  showRemediationConfirm: boolean
  showCreateRemediation: boolean
  showLinkRemediation: boolean
  createRemediationForm: { title: string }
  linkRemediationForm: { issue_uuid: string; issue_number: string; issue_title: string }
  creatingRemediation: boolean
  linkingRemediation: boolean
  onRefresh: () => void
  onSetCreateRemediationForm: (v: { title: string }) => void
  onSetLinkRemediationForm: (v: { issue_uuid: string; issue_number: string; issue_title: string }) => void
  onSetShowCreateRemediation: (v: boolean) => void
  onSetShowLinkRemediation: (v: boolean) => void
  onSetShowRemediationConfirm: (v: boolean) => void
  onCreateRemediation: () => void
  onLinkRemediation: () => void
  onRefreshRemediation: () => void
  onConfirmRemediation: (nextAction: 're_review') => void
  onSetRemediationMsg: (v: string) => void
}> = (props) => {
  const { data, effState, isCreator, isPublisher } = props
  const allIssues: any[] = data.linked_issues || []
  const remediationIssues: any[] = data.remediation_issues || []
  const allDone = data.remediation_all_done
  const remediationStatusState = data.remediation_status_state || (allDone ? 'done' : 'unknown')
  const isRemediationPhase = effState === 'remediation_pending'
  const creationBlocked = props.remediationTypeStatus === 'loading'
    || props.remediationTypeStatus === 'missing'
    || props.remediationTypeStatus === 'unknown'

  // 工作项列表（全部），用 badge 区分类型
  const issueRows = allIssues.map((iss: any, i: number) => {
    const isRemediation = iss.link_type === 'remediation'
    return (
      <tr key={i}>
        <td style={S.td}><a href={`/project/#/team/${getTeamUUID()}/project/${props.projectUuid}/issue/${iss.issue_number || iss.issue_uuid}`} target="_blank" style={{ color: '#1677ff', textDecoration: 'none', fontFamily: 'monospace', fontSize: 11 }}>{iss.issue_number || '-'}</a></td>
        <td style={S.td}>{iss.issue_title || '-'}</td>
        <td style={S.td}>{iss.issue_type || '-'}</td>
        <td style={S.td}>
          <span style={{ color: '#666' }}>{iss.issue_status || '-'}</span>
        </td>
        <td style={S.td}>
          {isRemediation
            ? <span style={{ padding: '1px 6px', borderRadius: 3, background: '#fff7e6', color: '#fa8c16', fontSize: 11, border: '1px solid #faad14' }}>整改项</span>
            : <span style={{ padding: '1px 6px', borderRadius: 3, background: '#e6f4ff', color: '#1677ff', fontSize: 11, border: '1px solid #91caff' }}>评审问题</span>}
        </td>
      </tr>
    )
  })

  return (
    <div>
      <div style={S.sectionTitle}>
        工作项（{allIssues.length}个，整改项 {remediationIssues.length}个）
        {isRemediationPhase && remediationIssues.length > 0 && (
          <button style={{ ...S.btn(false), marginLeft: 12, fontSize: 12 }} onClick={props.onRefreshRemediation} disabled={props.remediationRefreshing}>
            {props.remediationRefreshing ? '刷新中…' : '刷新状态'}
          </button>
        )}
      </div>

      {props.remediationMsg && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#cf1322' }}>{props.remediationMsg}</div>
      )}
      {props.remediationTypeMessage && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff2f0', color: '#cf1322', border: '1px solid #ffccc7' }}>
          {props.remediationTypeMessage}
        </div>
      )}

      {allIssues.length === 0 ? (
        <div style={{ color: '#999', padding: 24, textAlign: 'center', background: '#fafafa', borderRadius: 8, marginBottom: 16 }}>
          暂无工作项
          {(isRemediationPhase || effState === 'reviewing' || effState === 'awaiting_resolution') && (
            <div style={{ marginTop: 8 }}>
              <button style={S.btn(true, creationBlocked)} disabled={creationBlocked} onClick={() => { props.onSetShowCreateRemediation(true); props.onSetRemediationMsg('') }}>+ 创建工作项</button>
              <button style={{ ...S.btn(false), marginLeft: 8 }} onClick={() => { props.onSetShowLinkRemediation(true); props.onSetRemediationMsg('') }}>关联已有工作项</button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead><tr>
                <th style={S.th}>ID</th><th style={S.th}>标题</th><th style={S.th}>工作项类型</th><th style={S.th}>状态</th><th style={S.th}>分类</th>
              </tr></thead>
              <tbody>{issueRows}</tbody>
            </table>
          </div>

          {(isRemediationPhase || effState === 'reviewing' || effState === 'awaiting_resolution') && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={S.btn(true, creationBlocked)} disabled={creationBlocked} onClick={() => { props.onSetShowCreateRemediation(true); props.onSetRemediationMsg('') }}>+ 创建工作项</button>
              <button style={S.btn(false)} onClick={() => { props.onSetShowLinkRemediation(true); props.onSetRemediationMsg('') }}>关联已有工作项</button>
            </div>
          )}

          {isRemediationPhase && remediationStatusState === 'unknown' && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff7e6', color: '#ad6800', border: '1px solid #ffd591' }}>
              整改项状态尚未通过 ONES 权威校验，暂不能发起复审
            </div>
          )}

          {isRemediationPhase && allDone && remediationStatusState === 'done' && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#f6ffed', color: '#52c41a', border: '1px solid #b7eb8f' }}>
              所有整改项已完成，可在评审单顶部发起复审
            </div>
          )}

          {isRemediationPhase && !allDone && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, fontSize: 13, background: '#fff7e6', color: '#fa8c16' }}>
              部分整改项尚未完成，完成后可在评审单顶部发起复审
            </div>
          )}
        </>
      )}

      {/* 创建整改项表单 */}
      {props.showCreateRemediation && (
        <div style={{ ...S.card, marginTop: 16, background: '#f0f5ff' }}>
          <div style={S.sectionTitle}>创建工作项</div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>标题 *</label>
            <input style={S.input} value={props.createRemediationForm.title}
              onChange={e => props.onSetCreateRemediationForm({ title: e.target.value })}
              placeholder="整改项标题" disabled={props.creatingRemediation || creationBlocked} />
          </div>
          {props.remediationIssueType && (
            <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>类型将自动预填：{props.remediationIssueType}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btn(true, creationBlocked || props.creatingRemediation)} onClick={props.onCreateRemediation} disabled={props.creatingRemediation || creationBlocked}>
              {props.creatingRemediation ? '创建中…' : '创建'}
            </button>
            <button style={S.btn(false)} onClick={() => { props.onSetShowCreateRemediation(false); props.onSetRemediationMsg('') }}>取消</button>
          </div>
        </div>
      )}

      {/* 关联已有工作项表单 */}
      {props.showLinkRemediation && (
        <div style={{ ...S.card, marginTop: 16, background: '#f0f5ff' }}>
          <div style={S.sectionTitle}>关联已有工作项</div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>工作项 UUID *</label>
            <input style={S.input} value={props.linkRemediationForm.issue_uuid}
              onChange={e => props.onSetLinkRemediationForm({ ...props.linkRemediationForm, issue_uuid: e.target.value })}
              placeholder="工作项 UUID" disabled={props.linkingRemediation} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>编号</label>
              <input style={S.input} value={props.linkRemediationForm.issue_number}
                onChange={e => props.onSetLinkRemediationForm({ ...props.linkRemediationForm, issue_number: e.target.value })}
                placeholder="如 TASK-123" disabled={props.linkingRemediation} />
            </div>
            <div style={{ flex: 2 }}>
              <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>标题</label>
              <input style={S.input} value={props.linkRemediationForm.issue_title}
                onChange={e => props.onSetLinkRemediationForm({ ...props.linkRemediationForm, issue_title: e.target.value })}
                placeholder="工作项标题" disabled={props.linkingRemediation} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btn(true)} onClick={props.onLinkRemediation} disabled={props.linkingRemediation}>
              {props.linkingRemediation ? '关联中…' : '关联'}
            </button>
            <button style={S.btn(false)} onClick={() => { props.onSetShowLinkRemediation(false); props.onSetRemediationMsg('') }}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
