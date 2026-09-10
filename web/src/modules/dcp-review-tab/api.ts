import { getTeamUUID, getAppID, DcpApiError } from '../../api'

function buildUrl(url: string): string {
  const tu = getTeamUUID()
  if (!tu) throw new DcpApiError('未获取到团队 UUID，请从 ONES 项目页面进入。', 0)
  return `/project/api/project/team/${tu}${url}`
}

function callApi<T = any>(url: string, options: { method?: string; body?: string } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const fullUrl = buildUrl(url)
    const xhr = new XMLHttpRequest()
    xhr.open(options.method || 'GET', fullUrl, true)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.setRequestHeader('Ones-Plugin-Id', '709xehle')
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText)
          // addition API: { body: {...} }, external API: { data: {...} }
          resolve(json.body || json.data || json)
        }
        catch { reject(new Error(`JSON parse error`)) }
      } else {
        // 尝试从响应体提取 error 字段
        let msg = `${xhr.status}`
        let payload: any = null
        try {
          const json = JSON.parse(xhr.responseText)
          payload = json.body || json.data || json
          msg = payload?.error || xhr.responseText.substring(0, 200)
        } catch { msg = xhr.responseText.substring(0, 200) }
        const error: any = new Error(msg)
        error.data = payload
        error.status = xhr.status
        reject(error)
      }
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(options.body || null)
  })
}

// ---- 基础 ----
export const getPluginConfig = () => callApi('/dcp/config')
export const savePluginConfig = (data: any) => callApi('/dcp/config', { method: 'POST', body: JSON.stringify(data) })

// ---- 用户搜索（加载团队成员，客户端过滤） ----
let _memberCache: { uuid: string; name: string; email: string; avatar: string }[] | null = null

async function fetchTeamMembers(tu: string): Promise<{ uuid: string; name: string; email: string; avatar: string }[]> {
  // 团队 members 列表（已验证可行）
  try {
    const res = await fetch(`/project/api/project/team/${tu}/members?limit=200`, { credentials: 'include' })
    if (res.ok) {
      const json = await res.json()
      // ONES 返回格式: { members: [...] }，也可能 { data: [...] }
      const list = json.members || json.data || json || []
      return (Array.isArray(list) ? list : []).map((u: any) => ({
        uuid: u.uuid || '',
        name: u.name || u.email || u.uuid || '',
        email: u.email || '',
        avatar: u.avatar || '',
      }))
    }
  } catch { /* 静默失败 */ }

  return []
}

// 获取团队成员名称映射（UUID → 姓名）
let _nameMapCache: Record<string, string> | null = null
export async function resolveReviewerNames(uuids: string[]): Promise<Record<string, string>> {
  if (!_nameMapCache) {
    const members = await fetchTeamMembers(getTeamUUID())
    _nameMapCache = {}
    for (const m of members) _nameMapCache[m.uuid] = m.name
  }
  const result: Record<string, string> = {}
  for (const uid of uuids) {
    result[uid] = _nameMapCache[uid] || uid
  }
  return result
}

export async function searchUsers(keyword: string): Promise<{ uuid: string; name: string; email: string; avatar: string }[]> {
  const tu = getTeamUUID()
  if (!tu) throw new DcpApiError('未获取到团队 UUID', 0)

  // 首次加载全部团队成员并缓存
  if (!_memberCache) {
    _memberCache = await fetchTeamMembers(tu)
  }

  if (!keyword || !keyword.trim()) return _memberCache.slice(0, 20)
  const kw = keyword.trim().toLowerCase()
  return _memberCache.filter(u =>
    u.name.toLowerCase().includes(kw) || u.email.toLowerCase().includes(kw)
  ).slice(0, 20)
}

// ONES 项目成员管理是页面内部 API，需要在用户登录态下调用。
// 提交时必须带上项目成员角色的完整成员集合，避免覆盖原有成员。
export async function ensureProjectMembers(projectUuid: string, userUuids: string[]): Promise<void> {
  const teamUuid = getTeamUUID()
  const requested = [...new Set(userUuids.filter(Boolean))]
  if (!teamUuid || !projectUuid || requested.length === 0) return

  const fail = (reason: string, userUuid = requested[0] || '') => {
    const error: any = new Error(reason || '项目成员同步失败')
    error.data = {
      code: 'PROJECT_MEMBER_ADD_FAILED',
      user_uuid: userUuid,
      project_uuid: projectUuid,
      reason: reason || '项目成员同步失败',
    }
    throw error
  }

  const rolesResponse = await fetch(
    `/project/api/project/team/${teamUuid}/project/${projectUuid}/role_members`,
    { credentials: 'include' }
  )
  if (!rolesResponse.ok) fail(`读取项目成员失败（${rolesResponse.status}）`)
  const rolesJson = await rolesResponse.json()
  const roleMembers = rolesJson?.data?.role_members || rolesJson?.role_members || []
  const roleItems = Array.isArray(roleMembers) ? roleMembers : []
  const projectMemberRole = roleItems.find((item: any) => item?.role?.is_project_member)
    || roleItems.find((item: any) => item?.role?.name === '项目成员')
  const roleUuid = projectMemberRole?.role?.uuid || ''
  if (!roleUuid) fail('未找到项目成员角色')

  const existingMembers = (Array.isArray(projectMemberRole.members) ? projectMemberRole.members : [])
    .map((member: any) => typeof member === 'string' ? member : member?.uuid)
    .filter(Boolean)
  const missing = requested.filter(uuid => !existingMembers.includes(uuid))
  if (missing.length === 0) return

  const members = [...new Set([...existingMembers, ...missing])]
  const updateResponse = await fetch(
    `/project/api/project/team/${teamUuid}/project/${projectUuid}/role/${roleUuid}/members/update`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    }
  )
  if (!updateResponse.ok) {
    let reason = `更新项目成员失败（${updateResponse.status}）`
    try {
      const payload = await updateResponse.json()
      reason = payload?.reason || payload?.message || payload?.data?.reason || reason
    } catch {}
    fail(reason, missing[0])
  }

  const updateJson = await updateResponse.json()
  const updatedRoles = updateJson?.data?.role_members || updateJson?.role_members || []
  const updatedRole = (Array.isArray(updatedRoles) ? updatedRoles : []).find((item: any) => item?.role?.uuid === roleUuid)
  const updatedMembers = (Array.isArray(updatedRole?.members) ? updatedRole.members : [])
    .map((member: any) => typeof member === 'string' ? member : member?.uuid)
    .filter(Boolean)
  const notAdded = missing.find(uuid => !updatedMembers.includes(uuid))
  if (notAdded) fail('项目成员接口未返回新增成员', notAdded)
}

// ---- 评审单 ----
export const createReview = (data: any) => callApi('/dcp/review', { method: 'POST', body: JSON.stringify(data) })
export const getReviewDetail = (uuid: string) => callApi(`/dcp/review/${uuid}`)
export const listReviewsByProject = (puuid: string, reviewType?: string) => {
  const params = new URLSearchParams()
  if (reviewType) params.set('review_type', reviewType)
  const query = params.toString()
  return callApi(`/dcp/reviews/by-project/${puuid}${query ? `?${query}` : ''}`)
}
export const listTeamReviews = () => callApi('/dcp/reviews/team')
export const startReview = (uuid: string, data?: any) => callApi(`/dcp/review/${uuid}/start`, { method: 'POST', body: JSON.stringify(data || {}) })
export const recallReview = (uuid: string, data?: any) => callApi(`/dcp/review/${uuid}/recall`, { method: 'POST', body: JSON.stringify(data || {}) })
export const updateReviewBasicInfo = (uuid: string, data?: any) => callApi(`/dcp/review/${uuid}/basic-info`, { method: 'POST', body: JSON.stringify(data || {}) })
export const deleteReview = (uuid: string, data?: any) => callApi(`/dcp/review/${uuid}`, { method: 'DELETE', body: JSON.stringify(data || {}) })
export const recreateReview = (uuid: string, data?: any) => callApi(`/dcp/review/${uuid}/recreate`, { method: 'POST', body: JSON.stringify(data || {}) })

// ---- 材料 & 指标 ----
export const updateMaterialStatus = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/material-status`, { method: 'POST', body: JSON.stringify(data) })
export const uploadMaterialFile = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/material-upload`, { method: 'POST', body: JSON.stringify(data) })
export const removeMaterialFile = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/material-remove`, { method: 'POST', body: JSON.stringify(data) })
export const getMaterialUploadUrl = (reviewUuid: string, templateId: string) => callApi(`/dcp/review/${reviewUuid}/material/${templateId}/upload-url`)
export const getMaterialDownloadUrl = (reviewUuid: string, templateId: string) => callApi(`/dcp/review/${reviewUuid}/material/${templateId}/download-url`)
export const getMaterialPreview = (reviewUuid: string, templateId: string) => callApi(`/dcp/review/${reviewUuid}/material/${templateId}/preview`)
export const getAttachmentDownloadUrl = (reviewUuid: string, objectKey: string) => callApi(`/dcp/review/${reviewUuid}/material-attachment/download-url?object_key=${encodeURIComponent(objectKey)}`)
export const getAttachmentPreview = (reviewUuid: string, objectKey: string, fileName: string) => callApi(`/dcp/review/${reviewUuid}/material-attachment/preview?object_key=${encodeURIComponent(objectKey)}&file_name=${encodeURIComponent(fileName)}`)
export const updateIndicators = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/indicators`, { method: 'POST', body: JSON.stringify(data) })

// ---- 评审人 & 意见 ----
export const updateReviewers = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/reviewers`, { method: 'POST', body: JSON.stringify(data) })
export const submitOpinion = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/opinion`, { method: 'POST', body: JSON.stringify(data) })

// ---- 关联工作项 ----
export const linkIssue = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/link-issue`, { method: 'POST', body: JSON.stringify(data) })
export const getLinkedIssues = (uuid: string) => callApi(`/dcp/review/${uuid}/linked-issues`)

// ---- 决议 & 补充 ----
export const generateResolution = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/generate-resolution`, { method: 'POST', body: JSON.stringify(data) })
export const publishResolution = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/publish-resolution`, { method: 'POST', body: JSON.stringify(data) })
export const addSupplement = (uuid: string, data: any) => callApi(`/dcp/review/${uuid}/supplement`, { method: 'POST', body: JSON.stringify(data) })

// ---- 审计 ----
export const getAuditLog = (uuid: string) => callApi(`/dcp/review/${uuid}/audit-log`)

// ---- 催办 ----
export const remindReview = (uuid: string, data: { target: 'reviewers' | 'resolution'; operator_uuid: string; operator_name?: string }) =>
  callApi(`/dcp/review/${uuid}/remind`, { method: 'POST', body: JSON.stringify(data) })

// ---- 状态机 ----
export const transitionReview = (uuid: string, data: { target_state: 're_reviewing'; reason?: string }) =>
  callApi(`/dcp/review/${uuid}/transition`, { method: 'POST', body: JSON.stringify(data) })
export const getReviewState = (uuid: string) => callApi(`/dcp/review/${uuid}/state`)
export const getReviewRounds = (uuid: string) => callApi(`/dcp/review/${uuid}/rounds`)

// ---- 整改闭环 ----
export const getRemediationIssues = (uuid: string) => callApi(`/dcp/review/${uuid}/remediation`)
export const refreshRemediationStatus = (uuid: string) => callApi(`/dcp/review/${uuid}/remediation/refresh`, { method: 'POST' })
export const syncRemediationStatus = (uuid: string, items: Array<{ issue_uuid: string; status_name?: string; status_id?: string; category?: string | number }>) =>
  callApi(`/dcp/review/${uuid}/remediation/sync`, { method: 'POST', body: JSON.stringify({ items }) })
export const confirmRemediation = (uuid: string, data: { next_action: 're_review' }) =>
  callApi(`/dcp/review/${uuid}/remediation/confirm`, { method: 'POST', body: JSON.stringify(data) })

// ---- Reviewer Profile ----
export const listReviewerProfiles = (reviewType?: string) =>
  callApi(`/dcp/reviewer-profiles${reviewType ? `?review_type=${reviewType}` : ''}`)
export const createReviewerProfile = (data: { profile_name: string; review_type: string; description?: string; role_assignments: { role_name: string; mode: 'single' | 'pool'; default_reviewer_uuid?: string; candidate_uuids?: string[] }[] }) =>
  callApi('/dcp/reviewer-profile', { method: 'POST', body: JSON.stringify(data) })
export const getReviewerProfile = (profileId: string) =>
  callApi(`/dcp/reviewer-profile/${profileId}`)
export const updateReviewerProfile = (profileId: string, data: any) =>
  callApi(`/dcp/reviewer-profile/${profileId}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteReviewerProfile = (profileId: string) =>
  callApi(`/dcp/reviewer-profile/${profileId}`, { method: 'DELETE' })

// ---- Project Binding ----
export const listProjectBindings = (projectUuid?: string) =>
  callApi(`/dcp/project-bindings${projectUuid ? `?project_uuid=${projectUuid}` : ''}`)
export const upsertProjectBinding = (data: { project_uuid: string; profile_id: string; review_type: string }) =>
  callApi('/dcp/project-binding', { method: 'POST', body: JSON.stringify(data) })
export const deleteProjectBinding = (bindingId: string) =>
  callApi(`/dcp/project-binding/${bindingId}`, { method: 'DELETE' })

// ---- Apply Profile to Review ----
export const applyProfileToReview = (reviewUuid: string, profileId: string) =>
  callApi(`/dcp/review/${reviewUuid}/apply-profile`, { method: 'POST', body: JSON.stringify({ profile_id: profileId }) })
