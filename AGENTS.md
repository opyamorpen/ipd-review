# DCP 评审中心 v2 — AGENTS.md

ONES 团队级 DCP/TR 评审插件。支持 DCP 阶段决策评审和 TR 技术评审、多人异步评审、关联工作项、不可覆盖决议快照和审计追溯。

## 怎么跑起来

```bash
npm install && op init          # 安装依赖 + 初始化
npm run debug                  # 本地后端调试
npm run packup                 # 打包 .opk
./scripts/deploy.sh <opk文件>  # 直推升级到 demo688 环境（scripts/.env 存凭证，gitignored）
```

构建前必清缓存：`rm -rf node_modules/.cache web/dist`，否则 dist JS hash 不变 = 旧代码。

## 强制开发交付闭环

所有需求开发和 Bug 修复都必须完成以下流程后才能交付：

1. 修改代码并完成必要的类型检查、测试。
2. 构建前清理缓存：`rm -rf node_modules/.cache web/dist`。
3. 执行 `npm run packup`，确认 OPK 打包成功。
4. 执行 `./scripts/deploy.sh <opk文件>` 部署到 demo688。
5. 使用浏览器验证真实页面和用户流程，不能只以构建或部署成功作为完成依据。
6. 创建功能分支，提交全部相关修改并推送到 GitHub。
7. 创建目标为 `main` 的 Pull Request。
8. 等待 GitHub CI 的 `validate` 检查通过。
9. CI 通过后合并 PR 到 `main`。
10. 合并后同步本地 `main`，确认工作区干净并汇报最终提交号。

任一步失败或无法验证，都必须明确报告为 pending/blocked，不能声称任务已完成。

## 技术栈

- 前端：React 17 + TypeScript + Webpack（模块：dcp-review-tab、dcp-reviewer-workspace、dcp-sidebar 含子模块 dcp-template-config / dcp-review-overview、dcp-config-page、dcp-team-overview）
- 后端：Node.js External API（backend/src/index.ts 4452 行 + task-event-handler.ts），47 个 API 端点
- 存储：15 个 ONES Entity（dcp_base_config ~ dcp_checklist_result）
- 平台：ONES Open Platform，plugin.yaml 声明 3 个 Ability（ProjectCustomComponent、SidebarMenu、TaskEventHandler）

## 目录与约定

```
config/plugin.yaml    # 插件声明（实体、API、模块、权限、能力）
backend/src/index.ts  # 全部后端 API（4452 行）
backend/src/task-event-handler.ts  # 工作项事件钩子（taskPreAction/taskActionDone）—必须在 index.ts re-export，否则 packup 不打包→500
web/src/modules/      # 前端模块
scripts/deploy.sh     # 自动部署+五步验证脚本
docs/                 # 技术方案、需求方案
```

## 当前状态

- 版本：v1.31.9（plugin.yaml），host 1.11.33
- 技术方案文档标注 v1.11.32、需求方案标注 v1.11.33——**已严重滞后**（实际已迭代到 v1.31.x，新增 TR 评审、评审撤回、整改补充、IPD 流程布局、统计报表等）
- git: main 分支，4e839c9，工作区干净
- 部署：160 个 .opk 文件在根目录（.gitignore 已含 `*.opk`，不会被 git 跟踪）

## 下一步

- docs/技术方案.md 和 docs/需求方案.md 需要按 v1.31.x 现状同步更新
