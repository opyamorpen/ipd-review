# IPD评审（ipd-review）

ONES 开放平台 1.0 插件 —— 团队级 DCP/TR 评审中心（新架构）。

**架构**：评审单主体由系统自定义工作项承载（原生详情页 + 插件「评审过程」Tab + 快捷操作按钮），插件承载评审/审批全过程（角色会签、决议规则与门径校验、不可覆盖决议快照、多轮整改复审、审计追溯），`TaskEventHandler` 守卫工作项流转。Fork 自 dcp-review-v2 并重构，业务引擎零重写。

## 快速开始

```bash
npm install && op init     # 初始化
npm run packup             # 打包 .opk
npm run test:auth          # 授权策略契约测试
npm run test:guardrails    # 业务护栏契约测试
```

## 上线前置（环境侧）

1. 团队管理员创建自定义工作项类型「IPD评审单」并配置 11 态工作流，启用到目标项目。
2. 安装插件后在配置页「工作项映射」完成类型与状态映射。
3. 详见 [AGENTS.md](./AGENTS.md) 的部署前置与 PoC 清单。

## 文档

- 开发与交付规范：[AGENTS.md](./AGENTS.md)
- ONES 开放平台：<https://developer.ones.cn/zh-CN/>
- OP CLI：<https://developer.ones.cn/zh-CN/docs/tools/cli/op-cli>
