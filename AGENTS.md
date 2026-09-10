# IPD评审 — AGENTS.md

ONES 团队级 DCP/TR 评审插件（**新架构**）。 Fork 自 dcp-review-v2@555b249（v1.31.47）后按新架构改造：**评审单主体由系统自定义工作项承载，插件承载评审/审批全过程**。

## 架构要点（与旧版 dcp-review 的本质差异）

- 评审单 = 一种系统自定义工作项类型（管理员预建，配置页「工作项映射」选择）。评审单主键 `review_uuid` = 工作项 uuid。
- 原生工作项详情页 + 插件自定义 Tab（`LayoutCustomIssueTab` / `ones:issue:tab:new`）呈现评审过程：意见/材料指标/Checklist/决议快照/状态轨迹。
- 详情页右上角快捷操作（`LayoutCustomQuickAction` / `ones:global:modal`）：发起评审、提交意见、发布决议（含 422 门径一键降级）、催办、复审、撤回、确认整改。
- **插件是状态机唯一裁决方**：状态镜像经 `issue-service.pushStateMirror` 尽力同步到工作项（失败仅审计，不阻塞业务）。
- **字段镜像**（`issue-service.pushFieldMirror`）：会议时间/轮次/结论等按「工作项映射」的字段映射（`review_field_map`，默认映射见 `DEFAULT_REVIEW_FIELD_MAP`）写回工作项自定义字段；创建评审单时即带初始字段（`createReviewIssue.initialFieldValues`）。
- `TaskEventHandler`（taskPreAction）反向守门：拦截绕过插件的手动新建/流转/受保护字段修改/类型变更。**插件自身操作先写 `ipd_transition_intent` 意图（60s TTL）放行**——防止插件被自己的守卫拦截。
- **TaskEventHandler 的 ability config（issueTypeScope/field）已留空 + `show:false`**：平台侧不做事件过滤（管理页也不再显示这两项），类型识别/字段保护唯一来源是插件配置页；受保护字段 = `getProtectedFieldNames()`（字段映射的三个必配项）。
- **映射选择器数据源走 OpenAPI**（`GET /openapi/v2/project/issueTypes|issueStatuses|issueFields`，后端代理 `apiGetMappingOptions`）：后端用 `FetchAsAdmin` 以**插件身份自动鉴权**，**无需管理员配置任何凭据**（前提：plugin.yaml **顶层** `oauth.type=[admin]` + scope 声明，嵌套在 service 下无效）；`issue_transition_transport` JSON 里的 `openapi.host+token` 仅作个别环境的逃生门。失败回退内部 GraphQL（类型）/手动输入（字段/状态）。demo688 已实测通过（174 类型/229 状态/965 字段）。
- 事件：`issue-status:changed`（整改闭环，原有）+ `issue:updated`（字段级同步，新增）。
- 列表/工作台/总览点击评审单一律优先跳转原生工作项详情页（有 `issue_number` 时）。

## 怎么跑起来

```bash
npm install && op init          # 安装依赖 + 初始化
npm run debug                   # 本地后端调试
npm run packup                  # 打包 .opk
./scripts/deploy.sh <opk文件>   # 部署到 demo688：upload_opk + upgrade + 五步验证（读 scripts/.env）
```

构建前必清缓存：`rm -rf node_modules/.cache web/dist backend/dist`。

## 强制开发交付闭环

1. 修改代码并完成类型检查（backend/web 双 `tsc --noEmit`）与测试（`npm run test:auth` / `test:guardrails`）。
2. 清缓存后 `npx op packup --bump no-modify --release` 打包成功。
3. **走插件升级流程部署到 demo688**（`./scripts/deploy.sh <opk>`，见下节），并用浏览器验证真实页面与用户流程（不能只以构建成功为完成依据）。
4. 功能分支 → PR → CI（tsc + 双测试）通过 → 合并 main → 同步本地 main。

任一步失败或无法验证，必须明确报告 pending/blocked。

## 部署环境与升级流程（项目级强制要求）

**对本插件的一切后续修改，交付时必须走插件升级流程（`plugin/upload_opk` + `plugin/upgrade`），并自动部署至 demo688 环境。禁止卸载重装、禁止改动 `app_id`。**

- 环境：`https://demo688.ones.pro`，组织 `MVUtevnf`（Demo环境（保持更新））
- 团队：`VAVx7WoU`「客户成功-演示团队」
- 插件管理页：https://demo688.ones.pro/project/#/team/VAVx7WoU/team_setting/app_manager
- 登录账号：`wangshaobo@ones.cn`（密码等凭据在 `scripts/.env`，已被 .gitignore 忽略，勿提交）
- 部署命令：`./scripts/deploy.sh <opk文件>` —— 自动完成上传→upgrade→重启轮询→版本反查→业务验证五步，全部通过才判定部署完成
- 首次安装已完成；**之后每次修改一律走 upgrade**（deploy.sh）
- 为什么禁止卸载重装：卸载会清空 19 个 `ipd_*` 实体内的存量评审数据与配置（字段映射、状态映射等）
- 验证安装版本：app_manager 页面「IPD评审」条目版本号应等于 plugin.yaml 的 version

## 技术栈与结构

- 前端：React 17 + TS + Webpack。模块：`ipd-review-tab`（项目组件/列表/IPD流程图）、`ipd-reviewer-workspace`（工作台）、`ipd-sidebar`（配置/总览）、**`ipd-issue-tab`（工作项详情 Tab，含 Tab/Preview 子插槽）**、**`ipd-quick-action`（快捷操作弹窗）**。
- 后端：`backend/src/index.ts`（52 API + 业务引擎）+ **`issue-service.ts`（工作项服务层/意图/镜像）** + **`task-event-handler.ts`（流转守卫；必须在 index.ts re-export，否则 packup 不打包→500）**。
- 存储：19 个 ONES Entity（`ipd_*` 前缀；新增 `ipd_transition_intent`；`ipd_review` 增加 `issue_uuid`/`issue_number`）。
- plugin.yaml：5 个 Ability（ProjectCustomComponent、SidebarMenu、LayoutCustomIssueTab、LayoutCustomQuickAction、**TaskEventHandler**）。

## 部署前置（环境侧，一次性）

完整步骤见 `docs/工作项映射指南.md`（含字段规格表与状态清单）。概要：

1. 团队管理员创建自定义工作项类型（建议名「IPD评审单」）+ 指南中的自定义字段（同名字段可零配置）+ 评审状态工作流，启用到目标项目。
2. 插件配置页 →「工作项映射」三步：选类型 → 字段映射（7 项，3 必配）→ 状态映射（逐状态下拉/UUID）。
3. （可选）整改工作项类型在「整改设置」配置。

> OpenAPI 无需配置凭据：后端 `FetchAsAdmin` 以插件身份自动鉴权。

## 已知风险与待验证（PoC 清单）

- `TaskEventHandler` 在目标环境（私有部署，min_system_version 3.11.39+）对 API 直调/自动化路径的拦截可靠性——旧团队曾移除该能力（历史原因未考古），intent 机制 + 事件审计是双保险。
- `LayoutCustomIssueTab` 需 ONES v6.0.43+；工作项视图需管理员手动添加「评审过程」Tab（全局视图配一次）。
- `issue-service` 的内部 GraphQL 流转 mutation 与 OpenAPI 工作流端点**均未在真实环境验证**，可通过配置页 `issue_transition_transport` JSON 覆盖路径模板，无需改代码。
- ~~`FetchAsAdmin` 插件身份鉴权在 demo688 的可用性~~（2026-09-10 已验证，升级即生效无需重装）。
- ~~OpenAPI 三列表接口（issueTypes/issueStatuses/issueFields）在 demo688 的实测~~（2026-09-10 已验证：174 类型/229 状态/965 字段）。
- `tasks/add3` 携带自定义字段 `field_values` 的 value 格式（日期=毫秒时间戳？单选=选项中文名？）与 `tasks/update3` 字段更新端点形态（可用 `issue_transition_transport.field_update.internal_path` 覆盖）。
- 快捷操作按钮需在视图「概要信息卡片配置」中添加。
- 移动端 Tab 可用性未验证。
- `web/src/api.ts` 的 instance_id 映射（ipdrev01→?）需首次安装后回填。
- 存量 dcp-review 数据不迁移；两插件可并行（不同 app_id）。

## 历史坑（勿再踩）

- **本仓库 webpack.config.mjs 曾硬编码 pnpm 布局**（node_modules/.pnpm）；现已改为 require.resolve 优先 + pnpm 后备。npm 安装即可构建。
- **rollup 插件顺序**：rc-cli 默认插件（含 typescript2 检查）必须在前，`stripTypeScriptSyntax` 在末端兜底；顺序反了会让检查器读到 strip 后的 JS 产生整批误报（`never[]`/null 推断）。
- 构建器对 strip 后代码检查时，累加器必须用 `new Array<any>()` 而非 `: any[] = []`（后者 strip 后退化为 never[]）。
- 批量替换标识符时注意 package-lock.json 内 base64 哈希包含普通字母组合（曾发生 "Dcp"→"Ipd" 损坏哈希导致 EINTEGRITY）。
- **插件后端沙箱无 `URLSearchParams` 全局**（会抛 "URLSearchParams is not defined"）；query string 一律手工拼接。
- **`FetchAsAdmin` 要求 plugin.yaml 顶层 `oauth:` 声明**（`type: [admin]` + 官方 scope 列表中的名字），嵌套在 `service:` 下会被静默忽略，调用报 `Oauth2AdminTokenReq.Validate <OauthType.NotSupport>`（与 BI 仪表盘项目同环境结论一致，见 dev-ones-plugin-1 skill）。
- **`FetchAsAdmin` 返回 axios 包装**（真实 JSON 在 `res.data`），与 `OPFetch` 的 `{body}` 不同；解析需兼容 `res?.body ?? res?.data ?? res`。
- deploy.sh 第 5 步业务验证在升级后偶发 403（权限同步延迟），手动复查即可，不代表部署失败。

## 目录与约定

```
config/plugin.yaml                 # 插件声明（实体/API/模块/权限/能力/事件）
backend/src/index.ts                # 业务引擎 + 52 API（安全包装器出口在文件尾）
backend/src/issue-service.ts       # 工作项服务层：创建/意图/状态镜像/删除
backend/src/task-event-handler.ts  # TaskEventHandler 守卫（taskPreAction/taskActionDone）
web/src/modules/ipd-issue-tab/     # 工作项详情 Tab（tab/ + preview/）
web/src/modules/ipd-quick-action/  # 详情页快捷操作
scripts/deploy.sh                  # 部署脚本（目标环境参数见脚本头）
scripts/auth-policy.test.mjs       # 52 API 授权策略契约测试
scripts/review-guardrails.test.mjs # 业务护栏契约测试（含新架构 intent/守卫断言）
docs/                              # 继承自 dcp-review-v2，已滞后，待按新架构重写
```

## 当前状态

- 版本：v1.0.5（plugin.yaml），fork 基线 9705940
- CI：tsc（backend+web）+ auth-policy + guardrails 四项门禁
- 部署：已部署 demo688「客户成功-演示团队」（v1.0.5 运行中，2026-09-10 映射选项接口实测通过）；所有修改一律走升级流程，见「部署环境与升级流程」
