import assert from 'node:assert/strict'
import fs from 'node:fs'
import yaml from 'js-yaml'

const plugin = yaml.load(fs.readFileSync('config/plugin.yaml', 'utf8'))
const backend = fs.readFileSync('backend/src/index.ts', 'utf8')
const projectPage = fs.readFileSync('web/src/modules/dcp-review-tab/index.tsx', 'utf8')
const reviewerWorkspace = fs.readFileSync('web/src/modules/dcp-reviewer-workspace/index.tsx', 'utf8')

const expectedPolicies = {
  apiGetDcpConfig: 'identity',
  apiSavePluginConfig: 'admin',
  apiCreateReview: 'create',
  apiGetReviewDetail: 'review-read',
  apiListReviewsByProject: 'project-read',
  apiGetDcpReviews: 'overview',
  apiListMyReviews: 'self',
  apiListTeamReviews: 'overview',
  apiStartReview: 'review-creator',
  apiRecallReview: 'review-creator',
  apiUpdateReviewBasicInfo: 'review-creator',
  apiDeleteReview: 'review-creator',
  apiRecreateReview: 'review-create-creator',
  apiUpdateMaterialStatus: 'review-contributor',
  apiUploadMaterialFile: 'review-contributor',
  apiRemoveMaterialFile: 'review-contributor',
  apiGetMaterialUploadUrl: 'review-contributor',
  apiGetMaterialDownloadUrl: 'review-read',
  apiGetMaterialPreview: 'review-read',
  apiGetAttachmentDownloadUrl: 'review-read',
  apiGetAttachmentPreview: 'review-read',
  apiUpdateIndicators: 'review-contributor',
  apiUpdateReviewers: 'review-creator',
  apiSubmitOpinion: 'review-participant',
  apiLinkIssue: 'review-contributor',
  apiGetLinkedIssues: 'review-read',
  apiCreateIssue: 'review-contributor',
  apiListIssueTypes: 'project-read',
  apiGenerateResolution: 'review-publisher',
  apiPublishResolution: 'review-publisher',
  apiAddSupplement: 'review-contributor',
  apiGetAuditLog: 'review-read',
  apiCheckChecklist: 'review-participant',
  apiRemindReview: 'review-creator',
  apiTransitionReview: 'review-creator',
  apiGetReviewState: 'review-read',
  apiGetReviewRounds: 'review-read',
  apiGetRemediationIssues: 'review-read',
  apiRefreshRemediationStatus: 'review-creator-or-publisher',
  apiSyncRemediationStatus: 'review-creator-or-publisher',
  apiConfirmRemediation: 'review-publisher',
  apiGetDcpStats: 'overview',
  apiListReviewerProfiles: 'admin',
  apiCreateReviewerProfile: 'admin',
  apiGetReviewerProfile: 'admin',
  apiUpdateReviewerProfile: 'admin',
  apiDeleteReviewerProfile: 'admin',
  apiListProjectBindings: 'admin',
  apiUpsertProjectBinding: 'admin',
  apiDeleteProjectBinding: 'admin',
  apiApplyProfileToReview: 'review-create-creator',
}

const externalApis = plugin.apis.filter(api => api.type === 'external')
assert.equal(externalApis.length, Object.keys(expectedPolicies).length)
assert.equal(externalApis.some(api => api.url.includes('/debug/')), false)
assert.deepEqual(
  new Set(externalApis.map(api => api.function)),
  new Set(Object.keys(expectedPolicies)),
)

const actualPolicies = Object.fromEntries(
  [...backend.matchAll(/export const (api\w+) = withAuthorization\('([^']+)'/g)]
    .map(match => [match[1], match[2]]),
)
assert.deepEqual(actualPolicies, expectedPolicies)

const configHandler = backend.slice(
  backend.indexOf('export async function getPluginConfig'),
  backend.indexOf('export async function savePluginConfig'),
)
assert.equal(configHandler.includes('reviewerProfiles:'), false)
assert.equal(configHandler.includes('projectBindings:'), false)

const myReviewsHandler = backend.slice(
  backend.indexOf('export async function listMyReviews'),
  backend.indexOf('export async function startReview'),
)
assert.match(myReviewsHandler, /const reviewerUuid = getOperator\(req\)/)
assert.equal(myReviewsHandler.includes('reviewer_uuid='), false)
assert.match(projectPage, /\[hasCreatePerm, setHasCreatePerm\] = useState\(false\)/)
assert.match(reviewerWorkspace, /callApi\('\/dcp\/reviews\/my'\)/)

console.log(`Authorization policy coverage verified for ${externalApis.length} external APIs.`)
