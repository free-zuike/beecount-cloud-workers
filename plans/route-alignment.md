# 路由挂载对齐计划

## 原版 main.py 挂载配置（逐行）
```python
app.include_router(auth.router, prefix="/api/v1/auth")
app.include_router(two_factor.router, prefix="/api/v1/auth/2fa")
app.include_router(devices.router, prefix="/api/v1/devices")
app.include_router(sync.router, prefix="/api/v1/sync")
app.include_router(admin.router, prefix="/api/v1/admin")
app.include_router(admin_backup.router, prefix="/api/v1/admin/backup")
app.include_router(read.router, prefix="/api/v1/read")
app.include_router(write.router, prefix="/api/v1/write")
app.include_router(attachments.router, prefix="/api/v1/attachments")
app.include_router(profile.router, prefix="/api/v1/profile")
app.include_router(pats.router, prefix="/api/v1/profile/pats")
app.include_router(mcp_calls.router, prefix="/api/v1/profile/mcp-calls")
app.mount("/api/v1/mcp", mcp_server.app)
app.include_router(ai.router, prefix="/api/v1/ai")
app.include_router(import_router.router, prefix="/api/v1/import")
app.include_router(invites_router.router, prefix="/api/v1")
app.include_router(members_router.router, prefix="/api/v1")
app.include_router(shared_resources.router, prefix="/api/v1")
app.include_router(member_stats.router, prefix="/api/v1")
```

## 当前我们的 index.ts 挂载（需要对齐）
逐条检查差异并修复。
