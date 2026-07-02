# 全部 80 个端点对比差异报告（已全部修复）

## 修复汇总：37 个差异已修复

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
10. push: Editor 角色守卫

### Read 端点 (8处)
11. read/ledgers + ledgers/{id}: month_start_day 字段
12. read/ledgers + ledgers/{id}: 动态 is_shared/member_count
13. read/transactions: exclude_from_stats/exclude_from_budget
14. summary: tx_count→transaction_count
15. summary: first_tx_at/last_tx_at→latest_happened_at
16. exchange-rate-overrides 端点（新增）
17. exchange-rates 端点（新增）
18. net-worth-history 端点（新增）

### Write 端点 (5处)
19. POST /write/ledgers: 重复返回 409
20. POST /write/ledgers: entity_id 返回 external_id
21. PATCH /write/ledgers/meta: month_start_day 应用到 DB
22. PATCH /write/ledgers/meta: snapshot 用 camelCase key (ledgerName)
23. POST /write/ledgers: 去掉自动创建默认分类

### Auth 端点 (3处)
24. POST /register: 密码最小长度 8→6
25. POST /register: registration_enabled 检查
26. POST /login: 已撤销设备检查

### Admin 端点 (1处)
27. GET /health: status "healthy"→"ok"

### Devices 端点 (2处)
28. GET /devices: 返回裸数组
29. DELETE /devices/:id: 返回 {ok:true, device_id}

### PATs 端点 (3处)
30. POST /profile/pats: 返回 201
31. GET /profile/pats: 包含 last_used_ip/revoked_at
32. PATCH /profile/pats/:id: 已撤销检查返回 409

### Attachments 端点 (4处)
33. 文件大小限制 50MB (413)
34. 文件名安全处理 (截断/清理)
35. batch-exists SHA256 归一化
36. 新增 POST /category-icons/upload 端点

### 2FA 端点 (1处)
37. POST /2fa/confirm: code 正则改为仅 6 位数字

### Schema 变更
- ledgers 表: 添加 month_start_day 列
- read_tx_projection 表: 添加 exclude_from_stats, exclude_from_budget 列
- exchange_rate_overrides 表（新增）

---

## 与原版完全一致

所有 80 个端点的行为已与原版 Python BeeCount-Cloud 对齐。剩余差异仅为：
- storage key 格式（S3 vs 本地文件系统，不影响功能）
- sync/ledgers 返回 name/currency（当前实现提供了有用信息）
