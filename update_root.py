#!/usr/bin/env python3
"""修改 src/index.ts 的根路由"""
import re

with open('src/index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 替换根路由
old_route = r"app\.get\('/', \(c\) => \{\s*c\.header\('Content-Type', 'text/html; charset=utf-8'\);\s*return c\.body\(FRONTEND_HTML\);\s*\}\);"
new_route = """app.get('/', (c) => {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  return c.body('<html><body><h1>BeeCount Cloud</h1><p>Loading React App...</p><script>window.location.reload()</script></body></html>');
});"""

content = re.sub(old_route, new_route, content)

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ 根路由已更新")
