-- Supports the dashboard recent-episodes query (mvp-design.md section 15.2:
-- GET /api/dashboard) without a full-table sort: newest episodes first.
CREATE INDEX idx_episodes_created ON episodes(created_at DESC, id);
