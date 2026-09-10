import assert from 'node:assert/strict'
import fs from 'node:fs'
import yaml from 'js-yaml'

const backend = fs.readFileSync('backend/src/index.ts', 'utf8')
const plugin = yaml.load(fs.readFileSync('config/plugin.yaml', 'utf8'))
const projectPage = fs.readFileSync('web/src/modules/dcp-review-tab/index.tsx', 'utf8')
const workspace = fs.readFileSync('web/src/modules/dcp-reviewer-workspace/index.tsx', 'utf8')
const projectApi = fs.readFileSync('web/src/modules/dcp-review-tab/api.ts', 'utf8')
const projectIssueTypes = fs.readFileSync('web/src/project-issue-types.ts', 'utf8')
const remediationPanel = fs.readFileSync('web/src/modules/dcp-review-tab/RemediationPanel.tsx', 'utf8')
const configPage = fs.readFileSync('web/src/modules/dcp-config-page/index.tsx', 'utf8')

const transitionHandler = backend.slice(
  backend.indexOf('export async function transitionReview'),
  backend.indexOf('export async function getReviewState'),
)
assert.match(transitionHandler, /target_state !== 're_reviewing' \|\| currentState !== 'remediation_pending'/)
assert.match(transitionHandler, /STATE_TRANSITION_NOT_ALLOWED/)

const createHandler = backend.slice(
  backend.indexOf('export async function createReview'),
  backend.indexOf('export async function recreateReview'),
)
assert.match(createHandler, /findPhaseReviewConflict/)
assert.match(createHandler, /REVIEW_PHASE_ALREADY_ACTIVE/)
assert.match(createHandler, /claimPhaseGuard/)
assert.match(createHandler, /resolveCanonicalProjectIdentity/)
assert.match(createHandler, /withPhaseDependencySnapshot/)
assert.equal(createHandler.includes('project_aliases'), false)

const startHandler = backend.slice(
  backend.indexOf('export async function startReview'),
  backend.indexOf('export async function recallReview'),
)
assert.match(startHandler, /findPhaseReviewConflict\(projectIdentity\.lookupIds, rv\.phase_code, reviewType, rid\)/)
assert.match(startHandler, /claimPhaseGuard\(projectIdentity\.canonicalUuid/)
assert.match(startHandler, /getPhaseDependencySnapshot/)
assert.match(startHandler, /getClosedPassingPhases/)
assert.match(startHandler, /REVIEW_PHASE_GUARD_LOST/)
assert.equal(startHandler.includes('project_aliases'), false)

const passingPhaseHelper = backend.slice(
  backend.indexOf('async function getClosedPassingPhases'),
  backend.indexOf('export async function Enable'),
)
assert.match(passingPhaseHelper, /state !== 'completed' && state !== 'archived'/)
assert.match(passingPhaseHelper, /latest\?\.final_conclusion === 'pass' \|\| latest\?\.final_conclusion === 'conditional_pass'/)

const attachmentHandler = backend.slice(
  backend.indexOf('async function findAuthorizedAttachment'),
  backend.indexOf('export async function updateMaterialStatus'),
)
assert.match(attachmentHandler, /if \(!attachment\).*ATTACHMENT_NOT_FOUND/s)
assert.ok(attachmentHandler.indexOf('findAuthorizedAttachment(rid, objKey)') < attachmentHandler.indexOf('object\.download\(objKey\)'))

const evidenceHandlers = [
  ['uploadMaterialFile', 'removeMaterialFile'],
  ['removeMaterialFile', 'getMaterialUploadUrl'],
  ['getMaterialUploadUrl', 'getMaterialDownloadUrl'],
  ['updateMaterialStatus', 'updateIndicators'],
  ['updateIndicators', 'updateReviewers'],
]
for (const [start, end] of evidenceHandlers) {
  const source = backend.slice(
    backend.indexOf(`export async function ${start}`),
    backend.indexOf(`export async function ${end}`),
  )
  assert.match(source, /evidenceEditDenied/)
}
assert.match(backend, /state === 'draft' \|\| state === 'ready' \|\| state === 'remediation_pending'/)
assert.match(backend, /state === 'remediation_pending' \? currentRound \+ 1 : currentRound/)
assert.match(projectPage, /editable=\{data\.can_edit_evidence === true\}/)
assert.equal(projectPage.includes('project_aliases'), false)
assert.equal(projectApi.includes('project_aliases'), false)

const remediationHandler = backend.slice(
  backend.indexOf('type IssueCompletionState'),
  backend.indexOf('// ============================================================\n// Reviewer Profile'),
)
assert.match(remediationHandler, /issue_status_verification/)
assert.match(remediationHandler, /客户端状态只能作为观察值/)
assert.equal(remediationHandler.includes('isIssueStatusDone'), false)
assert.equal(projectPage.includes('is_done: isDone'), false)
assert.equal(workspace.includes('is_done: isDone'), false)

const backendIssueTypeLookup = backend.slice(
  backend.indexOf('async function getProjectIssueTypes'),
  backend.indexOf('export async function linkIssue'),
)
assert.match(backendIssueTypeLookup, /stamps\/data\?t=issue_type_config/)
assert.match(backendIssueTypeLookup, /project\(key:/)
assert.equal(backendIssueTypeLookup.includes('issueTypes(orderBy'), false)

const backendCreateIssue = backend.slice(
  backend.indexOf('export async function createIssue'),
  backend.indexOf('// ============================================================\n// 发布决议'),
)
assert.ok(backendCreateIssue.indexOf('REMEDIATION_ISSUE_TYPE_NOT_AVAILABLE') < backendCreateIssue.indexOf('/tasks/add3'))
assert.match(backendCreateIssue, /REMEDIATION_ISSUE_TYPE_UNVERIFIED/)
assert.match(backendCreateIssue, /link_type: 'remediation'/)
assert.match(backend, /remediation_issue_type_uuid/)

assert.match(projectIssueTypes, /stamps\/data\?t=issue_type_config/)
assert.match(projectIssueTypes, /projectIssueTypes/)
assert.equal(projectIssueTypes.includes('issueTypes(orderBy'), false)

const workspaceCreateIssueStart = workspace.indexOf('async function handleCreateIssue')
const workspaceCreateIssue = workspace.slice(
  workspaceCreateIssueStart,
  workspace.indexOf('\n return (', workspaceCreateIssueStart),
)
assert.ok(workspaceCreateIssue.indexOf('resolveCreationIssueType()') < workspaceCreateIssue.indexOf('/tasks/add3'))
assert.match(workspaceCreateIssue, /已创建，但关联评审单失败/)
assert.equal(workspaceCreateIssue.includes('} catch {}'), false)

const projectCreateIssue = projectPage.slice(
  projectPage.indexOf('async function handleCreateRemediationIssue'),
  projectPage.indexOf('async function handleLinkRemediationIssue'),
)
assert.ok(projectCreateIssue.indexOf('resolveProjectIssueTypes') < projectCreateIssue.indexOf('/tasks/add3'))
assert.match(projectCreateIssue, /field_uuid: 'field007'/)
assert.match(projectCreateIssue, /已创建，但关联评审单失败/)
assert.match(remediationPanel, /disabled=\{creationBlocked\}/)
assert.match(configPage, /remediation_issue_type_uuid: remediationIssueTypeUuid/)

const entities = plugin.storage.entities
const issueEntity = entities.find(entity => entity.name === 'dcp_linked_issue')
assert.ok(issueEntity.attributes.issue_status_verification)
assert.ok(issueEntity.attributes.issue_status_category)
assert.ok(entities.some(entity => entity.name === 'dcp_phase_guard'))
const reviewEntity = entities.find(entity => entity.name === 'dcp_review')
assert.equal(reviewEntity.attributes.canonical_project_uuid, undefined)
assert.equal(reviewEntity.attributes.phase_dependencies_snapshot_json, undefined)
assert.match(backend, /resolution_rule_json:[\s\S]*frozenRuleJson/)

assert.equal(plugin.abilities.some(ability => ability.abilityType === 'TaskEventHandler'), false)
assert.ok(plugin.events.some(event => event.eventType === 'ones:project:issue-status:changed' && event.function === 'onIssueStatusChanged'))
assert.equal(fs.existsSync('backend/src/task-event-handler.ts'), false)
assert.match(remediationHandler, /REMEDIATION_NOT_DONE/)
assert.match(remediationHandler, /REMEDIATION_STATUS_UNKNOWN/)
assert.match(remediationHandler, /已全部完成，请确认并发起复审/)
assert.equal(remediationHandler.includes('关联工作项已锁定'), false)

// 决议门径硬约束：发布「通过」前校验指标红线 / Checklist 完整 / 前置阶段有效
assert.match(backend, /async function validateResolutionGate\(/)
assert.match(backend, /RESOLUTION_GATE_BLOCKED/)
assert.match(backend, /gateViolations: gateResult\.violations/)
assert.match(backend, /suggestDowngrade: violations\.length > 0 \? 'conditional_pass'/)
assert.match(backend, /indicatorRedLine: 'block'/)
assert.match(backend, /prerequisiteRecheck !== false/)
// 前端：发布表单门径体检 + 422 拦截处理 + 一键降级
assert.match(projectPage, /RESOLUTION_GATE_BLOCKED/)
assert.match(projectPage, /gateViolations/)
assert.match(projectPage, /一键降级为/)
// 配置页：门径策略可配
assert.match(configPage, /gatePolicy\?\.indicatorRedLine/)
assert.match(configPage, /gatePolicy\?\.checklistComplete/)

console.log('Review guardrails verified: canonical prerequisites, phase uniqueness, evidence freeze, remediation status flow, and resolution gate enforcement.')
