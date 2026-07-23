export async function initializeDatabase(db: D1Database): Promise<void> {
  try {
    console.log('[INIT] Checking and creating database tables...');

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_is_enabled ON users(is_enabled)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id)').run();

    await db.prepare(`
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
        primary_currency TEXT,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)').run();

    // 为已有表添加 primary_currency 列（如果不存在）
    try {
      await db.prepare("ALTER TABLE user_profiles ADD COLUMN primary_currency TEXT").run();
    } catch { /* 列已存在则忽略 */ }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        client_type TEXT DEFAULT 'app',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id ON refresh_tokens(device_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)').run();

    // client_type 列后加的，旧表需要 ALTER
    try {
      await db.prepare("ALTER TABLE refresh_tokens ADD COLUMN client_type TEXT DEFAULT 'app'").run();
    } catch { /* 列已存在则忽略 */ }

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_user_id ON personal_access_tokens(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_token_hash ON personal_access_tokens(token_hash)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pats_prefix ON personal_access_tokens(prefix)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_pat_user_active ON personal_access_tokens(user_id, revoked_at)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_user_time ON mcp_call_logs(user_id, called_at DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_user_id ON mcp_call_logs(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_pat_id ON mcp_call_logs(pat_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_tool_name ON mcp_call_logs(tool_name)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_status ON mcp_call_logs(status)').run();

    await db.prepare(`
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
      )
    `).run();

    // For existing databases, add missing columns before creating indexes
    const safeAddColumn = async (table: string, column: string, def: string) => {
      try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`).run(); } catch { /* exists */ }
    };
    await safeAddColumn('audit_logs', 'entity_type', 'TEXT');
    await safeAddColumn('audit_logs', 'entity_id', 'TEXT');
    await safeAddColumn('audit_logs', 'details_json', 'TEXT');
    await safeAddColumn('audit_logs', 'metadata_json', 'TEXT');

    // read_tx_projection: add exclude columns
    await safeAddColumn('read_tx_projection', 'exclude_from_stats', 'BOOLEAN DEFAULT 0');
    await safeAddColumn('read_tx_projection', 'exclude_from_budget', 'BOOLEAN DEFAULT 0');

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_time ON audit_logs(user_id, created_at DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_logs_ledger ON audit_logs(ledger_id)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_last_seen_at ON devices(last_seen_at)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_revoked_at ON devices(revoked_at)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ledgers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        name TEXT,
        currency TEXT DEFAULT 'CNY' NOT NULL,
        role TEXT DEFAULT 'owner' NOT NULL,
        is_shared BOOLEAN DEFAULT 0 NOT NULL,
        month_start_day INTEGER DEFAULT 1,
        invite_code TEXT,
        invite_expires_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        UNIQUE(user_id, external_id)
      )
    `).run();

    // Migrate ledgers columns before indexes
    await safeAddColumn('ledgers', 'role', "TEXT DEFAULT 'owner' NOT NULL");
    await safeAddColumn('ledgers', 'is_shared', 'BOOLEAN DEFAULT 0 NOT NULL');
    await safeAddColumn('ledgers', 'invite_code', 'TEXT');
    await safeAddColumn('ledgers', 'invite_expires_at', 'TEXT');
    await safeAddColumn('ledgers', 'month_start_day', 'INTEGER DEFAULT 1');

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledgers_user_id ON ledgers(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledgers_external_id ON ledgers(external_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledgers_invite_code ON ledgers(invite_code)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ledger_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'editor' NOT NULL,
        joined_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        UNIQUE(ledger_id, user_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_members_ledger_id ON ledger_members(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_members_user_id ON ledger_members(user_id)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ledger_invites (
        id TEXT PRIMARY KEY,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        code TEXT UNIQUE NOT NULL,
        target_role TEXT DEFAULT 'editor' NOT NULL,
        invited_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_by TEXT REFERENCES users(id),
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_invites_code ON ledger_invites(code)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_user_cursor ON sync_changes(user_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_cursor ON sync_changes(ledger_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_latest ON sync_changes(ledger_id, entity_type, entity_sync_id, change_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_user_id ON sync_changes(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_ledger_id ON sync_changes(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity_type ON sync_changes(entity_type)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_action ON sync_changes(action)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_scope ON sync_changes(scope)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_cursors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        ledger_external_id TEXT NOT NULL,
        last_cursor INTEGER DEFAULT 0 NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        UNIQUE(user_id, device_id, ledger_external_id)
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_cursors_user_id ON sync_cursors(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_cursors_device_id ON sync_cursors(device_id)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_user_id ON sync_push_idempotency(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_push_idempotency_expires_at ON sync_push_idempotency(expires_at)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_snapshots_user_id ON backup_snapshots(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_snapshots_ledger_id ON backup_snapshots(ledger_id)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_remotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        config_summary TEXT NOT NULL,
        encrypted BOOLEAN DEFAULT 0 NOT NULL,
        last_test_at TEXT,
        last_test_ok BOOLEAN,
        last_test_error TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_remotes_backend_type ON backup_remotes(backend_type)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_user_id ON backup_schedules(user_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_schedules_enabled ON backup_schedules(enabled)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER REFERENCES backup_schedules(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
        remote_id INTEGER REFERENCES backup_remotes(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        log_text TEXT,
        bytes_total INTEGER,
        backup_filename TEXT,
        backup_path TEXT,
        started_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        finished_at TEXT
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_schedule_id ON backup_runs(schedule_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_ledger_id ON backup_runs(ledger_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS backup_restores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        run_id INTEGER REFERENCES backup_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'preparing',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_backup_restores_user_id ON backup_restores(user_id)').run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_sha256 ON attachment_files(sha256)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_ledger_created ON attachment_files(ledger_id, created_at)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_attachment_files_user_id ON attachment_files(user_id)').run();

    await db.prepare(`
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
      )
    `).run();

    // Migrate: add last_edited_by_user_id to existing read_tx_projection
    await safeAddColumn('read_tx_projection', 'last_edited_by_user_id', 'TEXT');
    // Migrate: add currency_code/native_amount for multi-currency (0018)
    await safeAddColumn('read_tx_projection', 'currency_code', 'TEXT');
    await safeAddColumn('read_tx_projection', 'native_amount', 'REAL');

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_time ON read_tx_projection(ledger_id, happened_at DESC, tx_index DESC)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_category ON read_tx_projection(ledger_id, category_sync_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_ledger_account ON read_tx_projection(ledger_id, account_sync_id)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_tx_user_time ON read_tx_projection(user_id, happened_at DESC)').run();

    await db.prepare(`
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
      )
    `).run();

    // user-global 实体的真正唯一约束：(user_id, sync_id)
    // 原版用独立表 UserAccountProjection，PK=(user_id, sync_id)
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS ix_read_account_user_sync ON read_account_projection(user_id, sync_id)').run();
    // 清理可能存在的重复行（保留 source_change_id 最大的）
    await db.prepare(`DELETE FROM read_account_projection WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM read_account_projection GROUP BY user_id, sync_id
    )`).run();

    await db.prepare(`
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
      )
    `).run();

    // user-global 唯一约束
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS ix_read_category_user_sync ON read_category_projection(user_id, sync_id)').run();
    await db.prepare(`DELETE FROM read_category_projection WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM read_category_projection GROUP BY user_id, sync_id
    )`).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_cat_ledger_kind ON read_category_projection(ledger_id, kind)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS read_tag_projection (
        ledger_id TEXT,
        sync_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        color TEXT,
        source_change_id INTEGER DEFAULT 0,
        PRIMARY KEY (ledger_id, sync_id)
      )
    `).run();

    // user-global 唯一约束
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS ix_read_tag_user_sync ON read_tag_projection(user_id, sync_id)').run();
    await db.prepare(`DELETE FROM read_tag_projection WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM read_tag_projection GROUP BY user_id, sync_id
    )`).run();

    await db.prepare(`
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
      )
    `).run();

    await db.prepare('CREATE INDEX IF NOT EXISTS ix_read_budget_ledger_cat ON read_budget_projection(ledger_id, category_sync_id)').run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id TEXT PRIMARY KEY,
        timezone_offset INTEGER DEFAULT 0,
        cloud_config_json TEXT,
        setup_completed BOOLEAN DEFAULT 0 NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS exchange_rate_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sync_id TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate TEXT NOT NULL,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
        UNIQUE(user_id, base_currency, quote_currency)
      )
    `).run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_exchange_rate_overrides_user ON exchange_rate_overrides(user_id)').run();

    console.log('[INIT] Database tables created/verified successfully');

  } catch (error) {
    console.error('[INIT] Failed to initialize database:', error);
  }
}
