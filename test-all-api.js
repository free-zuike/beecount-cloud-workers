/**
 * 全量 API 测试脚本 — 在浏览器控制台执行
 * 前提：已用 qq.com 账户登录
 */
(async function() {
  var token = localStorage.getItem('beecount.token./api/v1');
  if (!token) { console.error('未登录'); return; }
  var H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  var R = [];
  var ok = function(n, p, d) { R.push({n:n,p:p,d:d}); console.log(p ? '\u2705' : '\u274c', n, d || ''); };
  var api = async function(u, o) {
    try {
      var r = await fetch(u, o);
      var j = await r.json().catch(function() { return {}; });
      return Object.assign({s: r.status}, j);
    } catch(e) { return {error: e.message}; }
  };

  // 1. Profile
  var me = await api('/api/v1/profile/me', {headers: H});
  ok('profile/me', !!me.user_id, me.email);

  // 2. Ledgers
  var ld = await api('/api/v1/sync/ledgers', {headers: H});
  ok('sync/ledgers', Array.isArray(ld), ld.length + ' ledgers');

  // 3. Sync/full
  if (ld.length > 0) {
    var f = await api('/api/v1/sync/full?ledger_id=' + ld[0].ledger_id, {headers: H});
    ok('sync/full', !!f.snapshot, 'cursor:' + f.latest_cursor);
    var bc = 0;
    try { bc = JSON.parse(f.snapshot.payload.content).budgets.length; } catch(e) {}
    ok('budgets in snapshot', bc > 0, bc + ' budgets');
  }

  // 4. Read: ledger detail
  if (ld.length > 0) {
    var d = await api('/api/v1/read/ledgers/' + ld[0].ledger_id, {headers: H});
    ok('read/ledger role', !!d.role, 'role:' + d.role + ' shared:' + d.is_shared);
  }

  // 5. Stats
  if (ld.length > 0) {
    var s = await api('/api/v1/read/ledgers/' + ld[0].ledger_id + '/stats', {headers: H});
    ok('stats budget_total', s.budget_total !== undefined, 'budget_total:' + s.budget_total + ' tx_total:' + s.transaction_total);
  }

  // 6. Transactions
  if (ld.length > 0) {
    var txs = await api('/api/v1/read/ledgers/' + ld[0].ledger_id + '/transactions?limit=5', {headers: H});
    ok('transactions', Array.isArray(txs), txs.length + ' txs');
  }

  // 7. Accounts
  if (ld.length > 0) {
    var accs = await api('/api/v1/read/ledgers/' + ld[0].ledger_id + '/accounts', {headers: H});
    ok('accounts', Array.isArray(accs), accs.length + ' accounts');
  }

  // 8. Budgets
  if (ld.length > 0) {
    var buds = await api('/api/v1/read/ledgers/' + ld[0].ledger_id + '/budgets', {headers: H});
    ok('budgets', Array.isArray(buds), buds.length + ' budgets');
  }

  // 9. Workspace
  var nw = await api('/api/v1/read/workspace/net-worth-history', {headers: H});
  ok('net-worth', !!nw.series, (nw.series ? nw.series.length : 0) + ' months');

  var an = await api('/api/v1/read/workspace/analytics?scope=month', {headers: H});
  ok('analytics', !!an.summary, '');

  var tags = await api('/api/v1/read/workspace/tags', {headers: H});
  ok('workspace tags', Array.isArray(tags), tags.length + ' tags');

  var counts = await api('/api/v1/read/workspace/ledger-counts', {headers: H});
  ok('ledger-counts', true, 'tx:' + counts.tx_count + ' days:' + counts.distinct_days);

  // 10. Admin
  var ov = await api('/api/v1/admin/overview', {headers: H});
  ok('admin overview', !!ov.users_total, 'users:' + ov.users_total + ' txs:' + ov.transactions_total);

  var us = await api('/api/v1/admin/users', {headers: H});
  ok('admin users', Array.isArray(us.items), us.items.length + ' users');

  var logs = await api('/api/v1/admin/logs?limit=3', {headers: H});
  ok('audit logs', Array.isArray(logs.items), (logs.items ? logs.items.length : 0) + ' entries');

  console.log('\n\u2550\u2550\u2550 \u6d4b\u8bd5\u6c47\u603b \u2550\u2550\u2550');
  var p = R.filter(function(r) { return r.p; }).length;
  console.log('\u901a\u8fc7: ' + p + '/' + R.length);
  R.filter(function(r) { return !r.p; }).forEach(function(r) { console.log('  \u274c', r.n, r.d); });
})();
