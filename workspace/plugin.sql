-- DCP 评审中心 — 插件数据库初始化 SQL
-- ONES 存储后端对应 plugin.yaml 中声明的 storage.entities，此文件供 ImportSql() 参考

-- ============================================================
-- Reviewer Profile — 全局评审人 Profile（重用配置）
-- ============================================================
CREATE TABLE IF NOT EXISTS {{dcp_reviewer_profile}} (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  profile_name  VARCHAR(128) NOT NULL DEFAULT '',
  review_type   VARCHAR(8)   NOT NULL DEFAULT 'dcp',
  description   VARCHAR(512) NOT NULL DEFAULT '',
  role_assignments_json TEXT NOT NULL,  -- [{role_name, mode:'single'|'pool', default_reviewer_uuid, candidate_uuids[]}]
  created_by    VARCHAR(64)  NOT NULL DEFAULT '',
  created_at    BIGINT       NOT NULL DEFAULT 0,
  updated_at    BIGINT       NOT NULL DEFAULT 0
);

-- ============================================================
-- Project Binding — 项目与 Profile 绑定
-- ============================================================
CREATE TABLE IF NOT EXISTS {{dcp_project_binding}} (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_uuid  VARCHAR(64)  NOT NULL DEFAULT '',
  profile_id    VARCHAR(64)  NOT NULL DEFAULT '',
  review_type   VARCHAR(8)   NOT NULL DEFAULT 'dcp',
  created_by    VARCHAR(64)  NOT NULL DEFAULT '',
  created_at    BIGINT       NOT NULL DEFAULT 0,
  UNIQUE KEY uk_project_type (project_uuid, review_type)
);

-- dcp_linked_issue 新增 ONES 权威整改状态快照字段：
-- issue_status_id, issue_status_category, issue_status_is_done,
-- issue_status_verification, issue_status_source, issue_status_checked_at,
-- issue_status_error

-- dcp_phase_guard 保存同项目同阶段同类型的活动评审唯一占用记录。

-- ============================================================
-- dcp_review — 新增 Profile 快照字段
-- ============================================================
-- reviewer_profile_id              VARCHAR(64)  — 冻结时使用的 profile ID
-- reviewer_profile_name            VARCHAR(128) — 冻结时 profile 名称
-- reviewer_profile_snapshot_json   TEXT         — 冻结的完整 profile 快照
-- reviewer_binding_snapshot_json   TEXT         — 冻结的 binding 快照
-- reviewer_role_assignments_snapshot_json TEXT  — 冻结的角色分配快照 [{role_name, mode, default_reviewer_uuid, candidate_uuids[]}]

-- ============================================================
-- dcp_review_reviewer — 新增 selection mode 字段
-- ============================================================
-- selection_mode       VARCHAR(16)  — 'single' 或 'pool'
-- default_reviewer_uuid VARCHAR(64) — single 模式的默认评审人
-- candidate_uuids_json  TEXT        — pool 模式的候选池 UUID 列表 JSON
