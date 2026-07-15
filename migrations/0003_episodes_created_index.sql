-- Supports the dashboard recent-episodes query without a full-table sort:
-- newest episodes first.
CREATE INDEX idx_episodes_created ON episodes(created_at DESC, id);
