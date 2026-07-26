/**
 * 全量 API 测试脚本 — 在浏览器控制台执行
 * 前提：已用 qq.com 账户登录
 */
(async () => {
  const token = localStorage.getItem('beecount.token./api/v1');
  if (!token) { console.error('未登录'); return; }
  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const results = [];
  const ok = (n, p, d) => { results.push({n,p,d}); console.log(p?'✅':'❌', n, d||''); };
  const api = async (url, opts) => { try { const r = await fetch(url, opts); const j = await r.json().catch(()=>({})); return {status:r.status, ...j}; } catch(e) { return {error:e.message}; } };

  console.log('=== 1. 认证 ===');
  const me = await api('/api/v1/profile/me', {headers:H});
  ok('profile/me', !!me.user_id, `user: ${me.email}`);

  console.log('=== 2. 设备管理 ===');
  const devices = await api('/api/v1/admin/devices?view=deduped', {headers:H});
  ok('devices deduped', Array.isArray(devices), `${devices.length} devices`);

  console.log('=== 3. Sync: ledgers ===');
  const ledgers = await api('/api/v1/sync/ledgers', {headers:H});
  ok('sync/ledgers', Array.isArray(ledgers), `${ledgers.length} ledgers, roles: ${[...new Set(ledgers.map(l=>l.role))]}`);
  ok('sync/ledgers has shared', ledgers.some(l=>l.is_shared), '');

  console.log('=== 4. Sync: full ===');
  if (ledgers.length > 0) {
    const full = await api(`/api/v1/sync/full?ledger_id=${ledgers[0].ledger_id}`, {headers:H});
    ok('sync/full snapshot', !!full.snapshot, `cursor: ${full.latest_cursor}`);
    const budgetCount = full.snapshot?.payload ? JSON.parse(full.snapshot.payload.content).budgets?.length : 0;
    ok('sync/full has budgets', budgetCount > 0, `${budgetCount} budgets`);
  }

  console.log('=== 5. Read: ledger detail ===');
  if (ledgers.length > 0) {
    const det = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}`, {headers:H});
    ok('read/ledger', !!det.role, `role: ${det.role}, shared: ${det.is_shared}`);
  }

  console.log('=== 6. Read: transactions ===');
  if (ledgers.length > 0) {
    const txs = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}/transactions?limit=5`, {headers:H});
    ok('transactions', Array.isArray(txs), `${txs.length} txs`);
  }

  console.log('=== 7. Read: accounts ===');
  if (ledgers.length > 0) {
    const accs = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}/accounts`, {headers:H});
    ok('accounts', Array.isArray(accs), `${accs.length} accounts`);
    if (accs.length > 0) ok('account has hidden', 'hidden' in accs[0], `hidden: ${accs[0].hidden}`);
  }

  console.log('=== 8. Read: budgets ===');
  if (ledgers.length > 0) {
    const buds = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}/budgets`, {headers:H});
    ok('budgets', Array.isArray(buds), `${buds.length} budgets`);
    const usage = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}/budgets/usage`, {headers:H});
    ok('budgets/usage', !!usage?.items, `${usage?.items?.length || 0} usage`);
  }

  console.log('=== 9. Stats ===');
  if (ledgers.length > 0) {
    const stats = await api(`/api/v1/read/ledgers/${ledgers[0].ledger_id}/stats`, {headers:H});
    ok('stats', !!stats?.budget_count !== undefined, `budget_total: ${stats?.budget_total}, tx_total: ${stats?.transaction_total}`);
  }

  console.log('=== 10. Workspace ===');
  const analytics = await api('/api/v1/read/workspace/analytics?scope=month', {headers:H});
  ok('analytics', !!analytics?.summary, '');

  const tags = await api('/api/v1/read/workspace/tags', {headers:H});
  ok('workspace tags', Array.isArray(tags), `${tags.length} tags`);

  const counts = await api('/api/v1/read/workspace/ledger-counts', {headers:H});
  ok('ledger-counts', !!counts?.tx_count, `tx:${counts?.tx_count}, distinct_days:${counts?.distinct_days}`);

  const nw = await api('/api/v1/read/workspace/net-worth-history', {headers:H});
  ok('net-worth-history', !!nw?.series, `${nw?.series?.length || 0} months`);

  console.log('=== 11. Backup admin ===');
  const remotes = await api('/api/v1/admin/backup/remotes', {headers:H});
  ok('backup remotes', Array.isArray(remotes), `${remotes.length} remotes`);
  const schedules = await api('/api/v1/admin/backup/schedules', {headers:H});
  ok('backup schedules', Array.isArray(schedules), `${schedules.length} schedules`);

  console.log('=== 12. Audit logs ===');
  const logs = await api('/api/v1/admin/logs?limit=3', {headers:H});
  ok('audit logs', Array.isArray(logs.items), `${logs.items?.length || 0} entries`);

  console.log('=== 13. Admin users ===');
  const users = await api('/api/v1/admin/users', {headers:H});
  ok('admin users', Array.isArray(users.items), `${users.items?.length || 0} users`);

  console.log('=== 14. Admin overview ===');
  const overview = await api('/api/v1/admin/overview', {headers:H});
  ok('admin overview', !!overview?.users_total, `users:${overview?.users_total}, txs:${overview?.transactions_total}`);

  console.log('\n===== 测试汇总 =====');
  const p = results.filter(r=>r.p).length, f = results.filter(r=>!r.p).length;
  console.log(`通过: ${p}/${results.length}`);
  if (f) results.filter(r=>!r.p).forEach(r=>console.log(`  ❌ ${r.n}: ${r.d}`));
})();
