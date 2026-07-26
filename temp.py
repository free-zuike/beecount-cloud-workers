import sqlite3
import json
import os

# 读取 D1 状态
# 用 wrangler 查询当前状态
os.system('npx wrangler d1 execute beecount-cloud --remote --command "SELECT COUNT(*) FROM read_category_projection"')
