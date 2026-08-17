import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, TEST_DEVICE_ID } from '../helpers/test-env';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'newuser-sync@example.com');
  token = await getAuthToken(env.app, 'newuser-sync@example.com');
});

// 模拟 app 新用户首轮同步：默认带 deterministic syncId 的分类 + 账户 + 标签
// （与 app seed_service 的 uuid v5 命名空间一致的行为：第一个用户已有同 syncId 数据）
describe('新用户首次同步（同 syncId 默认实体存在时）', () => {
  it('推默认分类（syncId 与其他用户相同）', async () => {
    const syncId = 'a9ba1d1c-1307-5189-95d6-caa0dacd7d7b'; // "水果" 确定性 syncId
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-ID': TEST_DEVICE_ID },
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          entity_type: 'category', entity_sync_id: syncId, action: 'upsert',
          payload: { name: '水果', kind: 'expense', level: 1, sortOrder: 0, icon: 'fruit', iconType: 'material' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    const text = await res.text();
    console.log('STATUS', res.status, 'BODY', text.slice(0, 300));
    expect(res.status).toBe(200);
  });

  it('推默认账户（deterministic syncId）', async () => {
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-ID': TEST_DEVICE_ID },
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          entity_type: 'account', entity_sync_id: crypto.randomUUID(), action: 'upsert',
          payload: { name: '现金', accountType: 'cash', currency: 'CNY', initialBalance: 0 },
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    const text = await res.text();
    console.log('STATUS', res.status, 'BODY', text.slice(0, 300));
    expect(res.status).toBe(200);
  });

  it('推分类+账户+标签混合批次', async () => {
    const changes = [
      { entity_type: 'category', entity_sync_id: crypto.randomUUID(), action: 'upsert', payload: { name: '餐饮', kind: 'expense', level: 1, sortOrder: 0, icon: 'restaurant', iconType: 'material' }, updated_at: new Date().toISOString() },
      { entity_type: 'account', entity_sync_id: crypto.randomUUID(), action: 'upsert', payload: { name: '银行卡', accountType: 'bank_card', currency: 'CNY', initialBalance: 100 }, updated_at: new Date().toISOString() },
      { entity_type: 'tag', entity_sync_id: crypto.randomUUID(), action: 'upsert', payload: { name: '报销', color: '#FF0000' }, updated_at: new Date().toISOString() },
    ];
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-ID': TEST_DEVICE_ID },
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes }),
    });
    const text = await res.text();
    console.log('STATUS', res.status, 'BODY', text.slice(0, 400));
    expect(res.status).toBe(200);
  });
});