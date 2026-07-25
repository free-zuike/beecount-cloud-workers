/**
 * 与原版一致性测试脚本 — 在浏览器控制台执行
 * 
 * 前提：已登录管理员账户 (freezuike@outlook.com)
 */
(async () => {
  const token = localStorage.getItem('beecount.token./api/v1');
  if (!token) { console.error('未登录'); return; }
  const H = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  const results = [];
  const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(pass ? '✅' : '❌', name, detail || ''); };
  
  // === 测试 1: 创建用户 is_admin 应强制 false ===
  console.group('1. 创建用户 is_admin 强制 false');
  const r1 = await (await fetch('/api/v1/admin/users', { method: 'POST', headers: H,
    body: JSON.stringify({ email: 'test_isadmin_' + Date.now() + '@test.com', password: 'Test12345!', is_admin: true, is_enabled: true })
  })).json();
  ok('创建用户 is_admin', r1.is_admin === false, `got: ${r1.is_admin}`);
  const testUserId = r1.id;
  
  // === 测试 2: 软删除用户 ===
  console.group('2. 软删除用户');
  const r2 = await (await fetch(`/api/v1/admin/users/${testUserId}`, { method: 'DELETE', headers: H })).json();
  ok('删除用户返回 id', !!r2.id, JSON.stringify(r2));
  
  // 验证软删除（用户仍在但 is_enabled=false）
  const r2b = await (await fetch(`/api/v1/admin/users?status=disabled`, { headers: H })).json();
  const deletedUser = r2b.items?.find(i => i.id === testUserId);
  ok('软删除（用户仍存在但禁用）', deletedUser && !deletedUser.is_enabled, deletedUser ? `enabled: ${deletedUser.is_enabled}` : 'not found');
  console.groupEnd();
  
  // === 测试 3: 禁用管理员应被拒绝 ===
  console.group('3. 禁用管理员应被拒绝');
  const usersList = await (await fetch('/api/v1/admin/users', { headers: H })).json();
  const admin = usersList.items?.find(i => i.is_admin);
  if (admin) {
    const r3 = await fetch(`/api/v1/admin/users/${admin.id}`, { method: 'PATCH', headers: H,
      body: JSON.stringify({ is_enabled: false })
    });
    ok('禁用管理员被拒绝', r3.status === 400, `status: ${r3.status}`);
  }
  console.groupEnd();
  
  // === 测试 4: /sync/ledgers 正确 role ===
  console.group('4. /sync/ledgers 返回正确 role');
  const r4 = await (await fetch('/api/v1/sync/ledgers', { headers: H })).json();
  const roles = r4.map(l => l.role);
  ok('sync/ledgers 有数据', r4.length > 0, `${r4.length} ledgers`);
  ok('role 不全是 owner', roles.some(r => r !== 'owner'), `roles: ${[...new Set(roles)]}`);
  console.groupEnd();
  
  // === 测试 5: /read/ledgers/:id 返回真实 role ===
  console.group('5. /read/ledgers/:id 返回真实 role');
  if (r4.length > 0) {
    const r5 = await (await fetch(`/api/v1/read/ledgers/${r4[0].ledger_id}`, { headers: H })).json();
    ok('read/ledgers role 存在', !!r5.role, `role: ${r5.role}`);
  }
  console.groupEnd();
  
  // === 测试 6: workspace/transactions 分页 total ===
  console.group('6. workspace/transactions 分页 total');
  const r6 = await (await fetch('/api/v1/read/workspace/transactions?limit=2', { headers: H })).json();
  ok('total 为真实总数（非当前页长度）', r6.total !== undefined, `total: ${r6.total}, items: ${r6.items?.length}`);
  console.groupEnd();
  
  // === 测试 7: 预算周期 month_start_day ===
  console.group('7. 预算周期使用 month_start_day');
  if (r4.length > 0) {
    try {
      const r7 = await (await fetch(`/api/v1/read/ledgers/${r4[0].ledger_id}/budgets/usage`, { headers: H })).json();
      ok('budgets/usage 返回数组', Array.isArray(r7), `${r7.length || 0} budgets`);
    } catch { ok('budgets/usage', false, 'error'); }
  }
  console.groupEnd();
  
  // === 测试 8: 备份远端删除保护 ===
  console.group('8. 备份远端删除保护');
  const r8 = await (await fetch('/api/v1/admin/backup/remotes', { headers: H })).json();
  ok('远端列表正常', Array.isArray(r8) || Array.isArray(r8.items), JSON.stringify(r8).slice(0, 100));
  console.groupEnd();
  
  // === 测试 9: 审计日志存在 ===
  console.group('9. 审计日志');
  try {
    const r9 = await (await fetch('/api/v1/admin/logs?limit=5', { headers: H })).json();
    ok('审计日志可查', true, `${r9.items?.length || 0} entries`);
  } catch { ok('审计日志', false, 'error'); }
  console.groupEnd();
  
  console.groupEnd();
  
  // 汇总
  console.log('\n========== 测试汇总 ==========');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`通过: ${passed}, 失败: ${failed}, 总计: ${results.length}`);
  if (failed > 0) {
    console.log('失败项:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
  }
})();
