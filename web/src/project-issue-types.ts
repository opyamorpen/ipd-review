export type ProjectIssueType = {
  scope_uuid: string
  issue_type_uuid: string
  name: string
}

export type ProjectIssueTypesResult = {
  project_uuid: string
  types: ProjectIssueType[]
  verified: boolean
}

function normalizeTypes(raw: any[]): ProjectIssueType[] {
  return raw.map((item: any) => ({
    scope_uuid: item.uuid || item.scope_uuid || '',
    issue_type_uuid: item.issue_type_uuid || item.uuid || '',
    name: item.name || item.issue_type_name || item.type_name || item.display_name || '',
  })).filter((item: ProjectIssueType) => item.name)
}

export async function resolveProjectIssueTypes(teamUuid: string, projectRef: string): Promise<ProjectIssueTypesResult> {
  let projectUuid = projectRef
  try {
    const exchangeRes = await fetch(
      `/project/api/ones-project/team/${teamUuid}/projects/exchange/${projectRef}`,
      { credentials: 'include' },
    )
    if (exchangeRes.ok) {
      const exchange = await exchangeRes.json()
      projectUuid = exchange?.data?.project_uuid || exchange?.project_uuid || projectRef
    }
  } catch {}

  try {
    const stampRes = await fetch(
      `/project/api/project/team/${teamUuid}/project/${projectUuid}/stamps/data?t=issue_type_config`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_type_config: Date.now() }),
      },
    )
    if (stampRes.ok) {
      const stampData = await stampRes.json()
      const root = stampData?.data || stampData || {}
      const config = root.issue_type_config
      let raw: any[] | null = null
      if (Array.isArray(config)) raw = config
      else if (config && Array.isArray(config.issue_type_configs)) raw = config.issue_type_configs
      else if (config && Array.isArray(config.issue_types)) raw = config.issue_types
      if (raw) return { project_uuid: projectUuid, types: normalizeTypes(raw), verified: true }
    }
  } catch {}

  try {
    const gqlRes = await fetch(
      `/project/api/project/team/${teamUuid}/items/graphql?t=projectIssueTypes`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `{ project(key: "project-${projectUuid}") { issueTypes { uuid name } } }`,
          variables: {},
        }),
      },
    )
    if (gqlRes.ok) {
      const gql = await gqlRes.json()
      const raw = gql?.data?.project?.issueTypes
      if (Array.isArray(raw)) {
        return { project_uuid: projectUuid, types: normalizeTypes(raw), verified: true }
      }
    }
  } catch {}

  return { project_uuid: projectUuid, types: [], verified: false }
}

export function findConfiguredIssueType(
  types: ProjectIssueType[],
  configuredName: string,
  configuredUuid: string,
): ProjectIssueType | undefined {
  if (configuredUuid) {
    const byUuid = types.find(item =>
      item.issue_type_uuid === configuredUuid || item.scope_uuid === configuredUuid)
    if (byUuid) return byUuid
  }
  if (!configuredName) return undefined
  return types.find(item => item.name === configuredName)
}

export function remediationTypeBlockedMessage(
  status: 'loading' | 'available' | 'missing' | 'unknown' | 'unconfigured',
  configuredName: string,
): string {
  if (status === 'missing') {
    return `当前项目未添加 DCP 评审中心配置的整改工作项类型「${configuredName}」，不允许新建。请先在项目设置中添加该类型，或调整 DCP 评审中心的整改设置。`
  }
  if (status === 'unknown') return '无法确认当前项目的工作项类型，不允许新建整改项。请刷新后重试。'
  return ''
}
