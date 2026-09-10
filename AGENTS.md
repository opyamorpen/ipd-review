# IPD评审 — AGENTS.md

ONES 团队级 DCP/TR 评审插件（**新架构**）。 Fork 自 dcp-review-v2@555b249（v1.31.47）后按新架构改造：**评审单主体由系统自定义工作项承载，插件承载评审/审批全过程**。

## 架构要点（与旧版 dcp-review 的本质差异）

- 评审单 = 一种系统自定义工作项类型（管理员预建，配置页「工作项映射」选择）。评审单主键 `review_uuid` = 工作项 uuid。
- 原生工作项详情页 + 插件自定义 Tab（`LayoutCustomIssueTab` / `ones:issue:tab:new`）呈现评审过程：意见/材料指标/Checklist/决议快照/状态轨迹。
- 详情页右上角快捷操作（`LayoutCustomQuickAction` / `ones:global:modal`）：发起评审、提交意见、发布决议（含 422 门径一键降级）、催办、复审、撤回、确认整改。
- **插件是状态机唯一裁决方**：状态镜像经 `issue-service.pushStateMirror` 尽力同步到工作项（失败仅审计，不阻塞业务）。
- `TaskEventHandler`（taskPreAction）反向守门：拦截绕过插件的手动新建/流转/受保护字段修改/类型变更。**插件自身操作先写 `ipd_transition_intent` 意图（60s TTL）放行**——防止插件被自己的守卫拦截。
- 事件：`issue-status:changed`（整改闭环，原有）+ `issue:updated`（字段级同步，新增）。
- 列表/工作台/总览点击评审单一律优先跳转原生工作项详情页（有 `issue_number` 时）。

## 怎么跑起来

```bash
npm install && op init          # 安装依赖 + 初始化
npm run debug                   # 本地后端调试
npm run packup                  # 打包 .opk（首次安装用 plugin/upload_opk，非 upgrade）
./scripts/deploy.sh <opk文件>   # 部署（注意：新 app_id 首次安装流程待验证）
```

构建前必清缓存：`rm -rf node_modules/.cache web/dist backend/dist`。

## 强制开发交付闭环

1. 修改代码并完成类型检查（backend/web 双 `tsc --noEmit`）与测试（`npm run test:auth` / `test:guardrails`）。
2. 清缓存后 `npx op packup --bump no-modify --release` 打包成功。
3. 部署到目标环境并用浏览器验证真实页面与用户流程（不能只以构建成功为完成依据）。
4. 功能分支 → PR → CI（tsc + 双测试）通过 → 合并 main → 同步本地 main。

任一步失败或无法验证，必须明确报告 pending/blocked。

## 技术栈与结构

- 前端：React 17 + TS + Webpack。模块：`ipd-review-tab`（项目组件/列表/IPD流程图）、`ipd-reviewer-workspace`（工作台）、`ipd-sidebar`（配置/总览）、**`ipd-issue-tab`（工作项详情 Tab，含 Tab/Preview 子插槽）**、**`ipd-quick-action`（快捷操作弹窗）**。
- 后端：`backend/src/index.ts`（51 API + 业务引擎）+ **`issue-service.ts`（工作项服务层/意图/镜像）** + **`task-event-handler.ts`（流转守卫；必须在 index.ts re-export，否则 packup 不打包→500）**。
- 存储：19 个 ONES Entity（`ipd_*` 前缀；新增 `ipd_transition_intent`；`ipd_review` 增加 `issue_uuid`/`issue_number`）。
- plugin.yaml：5 个 Ability（ProjectCustomComponent、SidebarMenu、LayoutCustomIssueTab、LayoutCustomQuickAction、**TaskEventHandler**）。

## 部署前置（环境侧，一次性）

1. 团队管理员创建自定义工作项类型（建议名「IPD评审单」），配置 11 个评审状态的工作流，启用到目标项目。
2. 插件配置页 →「工作项映射」：选择类型 + 填写状态映射 JSON（评审状态 → 工作流状态 UUID）。
3. （可选）配置 OpenAPI 组织凭据（host + token）用于状态镜像传输；默认走内部 GraphQL。

## 已知风险与待验证（PoC 清单）

- `TaskEventHandler` 在目标环境（私有部署，min_system_version 3.11.39+）对 API 直调/自动化路径的拦截可靠性——旧团队曾移除该能力（历史原因未考古），intent 机制 + 事件审计是双保险。
- `LayoutCustomIssueTab` 需 ONES v6.0.43+；工作项视图需管理员手动添加「评审过程」Tab（全局视图配一次）。
- `issue-service` 的内部 GraphQL 流转 mutation 与 OpenAPI 工作流端点**均未在真实环境验证**，可通过配置页 `issue_transition_transport` JSON 覆盖路径模板，无需改代码。
- 快捷操作按钮需在视图「概要信息卡片配置」中添加。
- 移动端 Tab 可用性未验证。
- `web/src/api.ts` 的 instance_id 映射（ipdrev01→?）需首次安装后回填。
- 存量 dcp-review 数据不迁移；两插件可并行（不同 app_id）。

## 历史坑（勿再踩）

- **本仓库 webpack.config.mjs 曾硬编码 pnpm 布局**（node_modules/.pnpm）；现已改为 require.resolve 优先 + pnpm 后备。npm 安装即可构建。
- **rollup 插件顺序**：rc-cli 默认插件（含 typescript2 检查）必须在前，`stripTypeScriptSyntax` 在末端兜底；顺序反了会让检查器读到 strip 后的 JS 产生整批误报（`never[]`/null 推断）。
- 构建器对 strip 后代码检查时，累加器必须用 `new Array<any>()` 而非 `: any[] = []`（后者 strip 后退化为 never[]）。
- 批量替换标识符时注意 package-lock.json 内 base64 哈希包含普通字母组合（曾发生 "Dcp"→"Ipd" 损坏哈希导致 EINTEGRITY）。

## 目录与约定

```
config/plugin.yaml                 # 插件声明（实体/API/模块/权限/能力/事件）
backend/src/index.ts               # 业务引擎 + 51 API（安全包装器出口在文件尾）
backend/src/issue-service.ts       # 工作项服务层：创建/意图/状态镜像/删除
backend/src/task-event-handler.ts  # TaskEventHandler 守卫（taskPreAction/taskActionDone）
web/src/modules/ipd-issue-tab/     # 工作项详情 Tab（tab/ + preview/）
web/src/modules/ipd-quick-action/  # 详情页快捷操作
scripts/deploy.sh                  # 部署脚本（目标环境参数见脚本头）
scripts/auth-policy.test.mjs       # 51 API 授权策略契约测试
scripts/review-guardrails.test.mjs # 业务护栏契约测试（含新架构 intent/守卫断言）
docs/                              # 继承自 dcp-review-v2，已滞后，待按新架构重写
```

## 当前状态

- 版本：v1.0.0（plugin.yaml），fork 基线 9705940
- CI：tsc（backend+web）+ auth-policy + guardrails 四项门禁
- 部署：**尚未部署**（demo688 首次安装流程待执行，见 PoC 清单）
