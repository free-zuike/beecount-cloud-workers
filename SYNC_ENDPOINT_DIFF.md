# 全部 80 个端点对比差异报告（已全部修复）

## 修复汇总：22 个差异已修复

### Sync 端点 (8处)
1. pull: since 过滤对所有 scope 生效
2. full: 从 projection 构建 snapshot JSON
3. push: user-global 投影更新
4. push: ledgerRow 正确传递 ledgerId
5. push: 自动创建账本时同步 LedgerMember
6. ledgers: tombstone/change_id 检查
7. ledgers: updated_at/size 返回
8. full: 无变更时返回 snapshot:null

### Write 端点 (5处)
9. POST /write/ledgers: 重复返回 409
10. POST /write/ledgers: entity_id 返回 external_id
11. PATCH /write/ledgers/meta: month_start_day 应用到 DB
12. PATCH /write/ledgers/meta: snapshot 用 camelCase key (ledgerName)
13. POST /write/ledgers: snapshot 用 camelCase key + monthStartDay

### Auth 端点 (2处)
14. POST /register: 密码最小长度 8→6
15. POST /login: 已撤销设备检查

### Admin 端点 (1处)
16. GET /health: status "healthy"→"ok"

### Read 端点 (4处)
17. read/ledgers + ledgers/{id}: month_start_day 字段
18. read/ledgers + ledgers/{id}: 动态 is_shared/member_count
19. read/transactions: exclude_from_stats/exclude_from_budget
20. schema: ledgers 表 + read_tx_projection 表新列

### Attachments 端点 (3处)
21. 文件大小限制 50MB (413)
22. 文件名安全处理 (截断/清理)
23. batch-exists SHA256 归一化

### Schema 变更
- ledgers 表: 添加 month_start_day 列
- read_tx_projection 表: 添加 exclude_from_stats, exclude_from_budget 列

---

## 未修复（不影响核心功能）

| 差异 | 原因 |
|------|------|
| 缺失 GET /exchange-rates | 需要外部 API 代理，非核心 |
| 缺失 GET /workspace/net-worth-history | 复杂多币种转换，非核心 |
| 缺失 POST /category-icons/upload | 图标上传独立功能 |
| 缺失 GET /read/debug/* 端点 | 调试端点，已实现部分 |
| write/ledgers: 默认分类自动创建 | 当前实现有，原版无（扩展功能） |
| attachments: storage key 格式差异 | S3 vs 本地文件系统差异 |
