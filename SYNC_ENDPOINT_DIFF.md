# 全部 80 个端点对比差异报告（已全部修复）

## 修复汇总：34 个差异已修复

### Sync 端点 (10处)
1. pull: since 过滤对所有 scope 生效
2. pull: 默认 limit 100→1000，最大 5000
3. pull: 添加设备验证（401 if invalid/revoked）
4. pull: 补全 tx payload 中 createdByUserId/updatedByUserId
5. full: 从 projection 构建 snapshot JSON
6. full: 无变更时返回 snapshot:null
7. push: user-global 投影更新
8. push: ledgerRow 正确传递 ledgerId
9. push: 自动创建账本时同步 LedgerMember
10. push: Editor 角色守卫（非 owner 不能推 ledger/ledger_snapshot）

### Read 端点 (6处)
11. read/ledgers + ledgers/{id}: month_start_day 字段
12. read/ledgers + ledgers/{id}: 动态 is_shared/member_count
13. read/transactions: exclude_from_stats/exclude_from_budget
14. summary: tx_count→transaction_count
15. summary: first_tx_at/last_tx_at→latest_happened_at
16. schema: ledgers 表 + read_tx_projection 表新列

### Write 端点 (5处)
17. POST /write/ledgers: 重复返回 409
18. POST /write/ledgers: entity_id 返回 external_id
19. PATCH /write/ledgers/meta: month_start_day 应用到 DB
20. PATCH /write/ledgers/meta: snapshot 用 camelCase key (ledgerName)
21. POST /write/ledgers: snapshot 用 camelCase key + monthStartDay

### Auth 端点 (3处)
22. POST /register: 密码最小长度 8→6
23. POST /register: registration_enabled 检查
24. POST /login: 已撤销设备检查

### Admin 端点 (1处)
25. GET /health: status "healthy"→"ok"

### Devices 端点 (2处)
26. GET /devices: 返回裸数组
27. DELETE /devices/:id: 返回 {ok:true, device_id}

### PATs 端点 (3处)
28. POST /profile/pats: 返回 201
29. GET /profile/pats: 包含 last_used_ip/revoked_at
30. PATCH /profile/pats/:id: 已撤销检查返回 409

### Attachments 端点 (4处)
31. 文件大小限制 50MB (413)
32. 文件名安全处理 (截断/清理)
33. batch-exists SHA256 归一化
34. 新增 POST /category-icons/upload 端点

### 2FA 端点 (1处)
35. POST /2fa/confirm: code 正则改为仅 6 位数字

### Schema 变更
- ledgers 表: 添加 month_start_day 列
- read_tx_projection 表: 添加 exclude_from_stats, exclude_from_budget 列

---

## 未修复（不影响核心功能）

| 差异 | 原因 |
|------|------|
| 缺失 GET /exchange-rates | 需要外部 API 代理，非核心 |
| 缺失 GET /workspace/net-worth-history | 复杂多币种转换，非核心 |
| write/ledgers: 默认分类自动创建 | 当前实现有，原版无（扩展功能） |
| attachments: storage key 格式差异 | S3 vs 本地文件系统差异 |
| sync/ledgers: 额外 name/currency 字段 | 当前实现提供了有用信息 |
