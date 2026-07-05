-- BeeCount Cloud D1 Schema (auto-generated from src/db/schema.ts)
-- 唯一来源：src/db/schema.ts — 运行时自动建表 + 迁移
-- 本文件仅供参考，不要手动执行

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT 0 NOT NULL,
    is_enabled BOOLEAN DEFAULT 1 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    totp_secret_encrypted TEXT,
    totp_enabled BOOLEAN DEFAULT 0 NOT NULL,
    totp_enabled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin);
CREATE INDEX IF NOT EXISTS idx_users_is_enabled ON users(is_enabled);

CREATE TABLE IF NOT EXISTS recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_file_id TEXT,
    avatar_version INTEGER DEFAULT 0,
    income_is_red BOOLEAN DEFAULT 1,
    theme_primary_color TEXT,
    appearance_json TEXT,
    ai_config_json TEXT,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    client_type TEXT DEFAULT 'app',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id ON refresh_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    scopes_json TEXT DEFAULT '[]' NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    revoked_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pats_user_id ON personal_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pats_token_hash ON personal_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_pats_prefix ON personal_access_tokens(prefix);
CREATE INDEX IF NOT EXISTS idx_pat_user_active ON personal_access_tokens(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS mcp_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pat_id TEXT REFERENCES personal_access_tokens(id) ON DELETE SET NULL,
    pat_prefix TEXT,
    pat_name TEXT,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    args_summary TEXT,
    duration_ms INTEGER DEFAULT 0,
    client_ip TEXT,
    called_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_user_time ON mcp_call_logs(user_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_id ON mcp_call_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_pat_id ON mcp_call_logs(pat_id);
CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_tool_name ON mcp_call_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_status ON mcp_call_logs(status);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    ledger_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details_json TEXT,
    metadata_json TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ledger ON audit_logs(ledger_id);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT DEFAULT 'Unknown Device',
    platform TEXT DEFAULT 'unknown',
    app_version TEXT,
    os_version TEXT,
    device_model TEXT,
    last_ip TEXT,
    last_seen_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    revoked_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at ON devices(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices(revoked_at);

CREATE TABLE IF NOT EXISTS ledgers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    name TEXT,
    currency TEXT DEFAULT 'CNY' NOT NULL,
    role TEXT DEFAULT 'owner' NOT NULL,
    is_shared BOOLEAN DEFAULT 0 NOT NULL,
    invite_code TEXT,
    invite_expires_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    UNIQUE(user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ledgers_user_id ON ledgers(user_id);
CREATE INDEX IF NOT EXISTS idx_ledgers_external_id ON ledgers(external_id);
CREATE INDEX IF NOT EXISTS idx_ledgers_invite_code ON ledgers(invite_code);

CREATE TABLE IF NOT EXISTS ledger_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'editor' NOT NULL,
    joined_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    UNIQUE(ledger_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_members_ledger_id ON ledger_members(ledger_id);
CREATE INDEX IF NOT EXISTS idx_ledger_members_user_id ON ledger_members(user_id);

CREATE TABLE IF NOT EXISTS ledger_invites (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    target_role TEXT DEFAULT 'editor' NOT NULL,
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_invites_ledger_id ON ledger_invites(ledger_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invites_code ON ledger_invites(code);
CREATE INDEX IF NOT EXISTS idx_ledger_invites_expires_at ON ledger_invites(expires_at);

CREATE TABLE IF NOT EXISTS sync_changes (
    change_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ledger_id TEXT,
    entity_type TEXT NOT NULL,
    entity_sync_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_device_id TEXT,
    updated_by_user_id TEXT,
    scope TEXT DEFAULT 'ledger'
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_user_cursor ON sync_changes(user_id, change_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_cursor ON sync_changes(ledger_id, change_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_latest ON sync_changes(ledger_id, entity_type, entity_sync_id, change_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_user_id ON sync_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_id ON sync_changes(ledger_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_type ON sync_changes(entity_type);
CREATE INDEX IF NOT EXISTS idx_sync_changes_action ON sync_changes(action);
CREATE INDEX IF NOT EXISTS idx_sync_changes_scope ON sync_changes(scope);

CREATE TABLE IF NOT EXISTS sync_cursors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    ledger_external_id TEXT NOT NULL,
    last_cursor INTEGER DEFAULT 0 NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    UNIQUE(user_id, device_id, ledger_external_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_user_id ON sync_cursors(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_cursors_device_id ON sync_cursors(device_id);

CREATE TABLE IF NOT EXISTS sync_push_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(user_id, device_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_user_id ON sync_push_idempotency(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_expires_at ON sync_push_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS backup_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL,
    note TEXT,
    kind TEXT DEFAULT 'snapshot',
    file_name TEXT,
    content_type TEXT,
    checksum TEXT,
    size INTEGER,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_snapshots_user_id ON backup_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_snapshots_ledger_id ON backup_snapshots(ledger_id);

CREATE TABLE IF NOT EXISTS backup_remotes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    backend_type TEXT NOT NULL,
    config_summary TEXT NOT NULL,
    encrypted BOOLEAN DEFAULT 0 NOT NULL,
    last_test_at TEXT,
    last_test_ok BOOLEAN,
    last_test_error TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_remotes_backend_type ON backup_remotes(backend_type);

CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    remote_ids TEXT,
    retention_days INTEGER DEFAULT 30,
    include_attachments BOOLEAN DEFAULT 1 NOT NULL,
    enabled BOOLEAN DEFAULT 1 NOT NULL,
    timezone_offset INTEGER DEFAULT 0,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_status TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_schedules_user_id ON backup_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled);

CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT REFERENCES backup_schedules(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    remote_id TEXT REFERENCES backup_remotes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    bytes_total INTEGER,
    backup_filename TEXT,
    backup_path TEXT,
    started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_user_id ON backup_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_ledger_id ON backup_runs(ledger_id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status);
CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS backup_restores (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    run_id TEXT REFERENCES backup_runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'preparing',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backup_restores_user_id ON backup_restores(user_id);

CREATE TABLE IF NOT EXISTS attachment_files (
    id TEXT PRIMARY KEY,
    ledger_id TEXT REFERENCES ledgers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER DEFAULT 0,
    mime_type TEXT,
    file_name TEXT,
    storage_path TEXT NOT NULL,
    attachment_kind TEXT DEFAULT 'transaction' NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachment_files_sha256 ON attachment_files(sha256);
CREATE INDEX IF NOT EXISTS idx_attachment_files_ledger_created ON attachment_files(ledger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachment_files_user_id ON attachment_files(user_id);

CREATE TABLE IF NOT EXISTS read_tx_projection (
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    sync_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tx_type TEXT NOT NULL,
    amount REAL DEFAULT 0.0,
    happened_at TEXT NOT NULL,
    note TEXT,
    category_sync_id TEXT,
    category_name TEXT,
    category_kind TEXT,
    account_sync_id TEXT,
    account_name TEXT,
    from_account_sync_id TEXT,
    from_account_name TEXT,
    to_account_sync_id TEXT,
    to_account_name TEXT,
    tags_csv TEXT,
    tag_sync_ids_json TEXT,
    attachments_json TEXT,
    tx_index INTEGER DEFAULT 0,
    created_by_user_id TEXT,
    last_edited_by_user_id TEXT,
    source_change_id INTEGER DEFAULT 0,
    exclude_from_stats BOOLEAN DEFAULT 0,
    exclude_from_budget BOOLEAN DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
);

CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_time ON read_tx_projection(ledger_id, happened_at DESC, tx_index DESC);
CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_category ON read_tx_projection(ledger_id, category_sync_id);
CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_account ON read_tx_projection(ledger_id, account_sync_id);
CREATE INDEX IF NOT EXISTS ix_read_tx_user_time ON read_tx_projection(user_id, happened_at DESC);

CREATE TABLE IF NOT EXISTS read_account_projection (
    ledger_id TEXT,
    sync_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    account_type TEXT,
    currency TEXT,
    initial_balance REAL,
    note TEXT,
    credit_limit REAL,
    billing_day INTEGER,
    payment_due_day INTEGER,
    bank_name TEXT,
    card_last_four TEXT,
    source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
);

CREATE TABLE IF NOT EXISTS read_category_projection (
    ledger_id TEXT,
    sync_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    kind TEXT,
    level INTEGER,
    sort_order INTEGER,
    icon TEXT,
    icon_type TEXT,
    custom_icon_path TEXT,
    icon_cloud_file_id TEXT,
    icon_cloud_sha256 TEXT,
    parent_name TEXT,
    source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
);

CREATE INDEX IF NOT EXISTS ix_read_cat_ledger_kind ON read_category_projection(ledger_id, kind);

CREATE TABLE IF NOT EXISTS read_tag_projection (
    ledger_id TEXT,
    sync_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    color TEXT,
    source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
);

CREATE TABLE IF NOT EXISTS read_budget_projection (
    ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    sync_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    budget_type TEXT,
    category_sync_id TEXT,
    amount REAL,
    period TEXT,
    start_day INTEGER,
    enabled BOOLEAN DEFAULT 1,
    source_change_id INTEGER DEFAULT 0,
    PRIMARY KEY (ledger_id, sync_id)
);

CREATE INDEX IF NOT EXISTS ix_read_budget_ledger_cat ON read_budget_projection(ledger_id, category_sync_id);

CREATE TABLE IF NOT EXISTS system_settings (
    id TEXT PRIMARY KEY,
    timezone_offset INTEGER DEFAULT 0,
    cloud_config_json TEXT,
    setup_completed BOOLEAN DEFAULT 0 NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
