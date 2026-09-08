#!/usr/bin/env node
/**
 * Schema 同步核对脚本 —— 每次同步上游后运行：
 *   node scripts/check-schema-sync.mjs
 *
 * 对比 upstream/main 的 Alembic 迁移（0001~0019 的最终结构）与我们的 src/db/schema.ts，
 * 输出逐表列差异。核心同步表必须一致（FAIL），服务端扩展按已知差异白名单放行。
 *
 * 退出码：0 = 无意外差异（白名单内差异仅提示）；1 = 有需要跟进的新差异。
 *
 * 只比表/列集合，不比类型/约束/索引（约束级差异见白名单注释）。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_REF = 'upstream/main';

// ---- 已知差异白名单（有意为之的服务端扩展）----
// oursOnlyTables: 我们独有的表（上游没有）
// columnAdditions: 我们比上游多的列
// columnMissing: 我们比上游少的列（warn 级）
const KNOWN = {
  oursOnlyTables: new Set([
    'app_metadata',      // schema 版本跟踪（Workers 冷启动跳过 DDL）
    'system_settings',   // setup 向导 + 服务器时区（上游用环境变量）
    'settings',          // key-value 配置（S3 上传配置等）
    'backup_restores',   // 恢复任务（上游无恢复表）
    'ai_image_cache',    // 截图记账缓存（D1+R2 持久化，上游无）
  ]),
  columnAdditions: {
    audit_logs: ['entity_type', 'entity_id', 'details_json', 'level', 'logger'],
    ledgers: ['role', 'is_shared', 'invite_code', 'invite_expires_at'],
    ledger_invites: ['id'],
    backup_snapshots: ['kind', 'file_name', 'content_type', 'checksum', 'size'],
    backup_schedules: ['remote_ids', 'timezone_offset'],
    backup_runs: ['ledger_id', 'remote_id', 'backup_path'],
    ledger_members: ['id'],                 // 我们自增主键 + UNIQUE(ledger_id,user_id)；上游复合主键
    refresh_tokens: ['client_type'],        // 标记 App/Web 来源，上游无
  },
  columnMissing: {
    ledger_members: ['invited_by'],   // 上游记录谁邀请的成员，我们未实现该列
    backup_remotes: ['user_id'],      // 上游按用户隔离远端；我们是单管理员全局（有意）
  },
};

// ---------- 上游 alembic 解析 ----------
function readString(text, pos) {
  const quote = text[pos];
  if (quote !== "'" && quote !== '"') return null;
  let i = pos + 1, out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
    if (ch === quote) return [out, i + 1];
    out += ch; i++;
  }
  return null;
}
function matchParen(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    else if (ch === "'" || ch === '"') { const r = readString(text, i); if (r) i = r[1] - 1; }
  }
  return -1;
}
function stringsInCall(text, from, to) {
  const out = [];
  let p = from;
  while (p < to) {
    const r = readString(text, p);
    if (!r) { p++; continue; }
    out.push(r[0]); p = r[1];
  }
  return out;
}
function columnNamesInBlock(text, start, end) {
  const cols = [];
  const re = /sa\.Column\(\s*["']/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index >= start && m.index < end) {
      const r = readString(text, re.lastIndex - 1);
      if (r) cols.push(r[0]);
    }
    if (m.index > end) break;
  }
  return cols;
}

function parseUpstreamSchema() {
  const files = execSync(`git ls-tree -r --name-only ${UPSTREAM_REF} -- alembic/versions`, { cwd: ROOT })
    .toString().trim().split('\n').filter(f => /\d{4}_.*\.py$/.test(f)).sort();
  const tables = new Map(); // name -> Set(columns)

  for (const file of files) {
    const full = execSync(`git show ${UPSTREAM_REF}:${file}`, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString();
    const upStart = full.indexOf('def upgrade');
    const downStart = full.indexOf('def downgrade', upStart + 1);
    const up = downStart > upStart ? full.slice(upStart, downStart) : full.slice(upStart);

    // op.create_table / op.add_column / op.drop_table（(?<!\w) 防止误匹配 batch_op.add_column 里的 op.）
    const opRe = /(?<!\w)op\.(create_table|add_column|drop_table)\(\s*/g;
    let m;
    while ((m = opRe.exec(up))) {
      const openIdx = up.indexOf('(', m.index);
      const closeIdx = matchParen(up, openIdx);
      const args = stringsInCall(up, opRe.lastIndex, closeIdx);
      const body = up.slice(openIdx + 1, closeIdx);
      if (m[1] === 'create_table') {
        const t = args[0];
        if (!tables.has(t)) tables.set(t, new Set());
        for (const c of columnNamesInBlock(body, 0, body.length)) tables.get(t).add(c);
      } else if (m[1] === 'add_column') {
        const [t, c] = args;
        if (!tables.has(t)) tables.set(t, new Set());
        tables.get(t).add(c);
      } else if (m[1] === 'drop_table') {
        tables.delete(args[0]);
      }
    }

    // batch_alter_table：有序扫描 —— batch_alter_table("t") 设当前表，后续
    // batch[(_op)].(add|drop)_column 归到当前表（0009 变量名是 batch，0010 是拆分写法）
    const batchRe = /(?<!\w)op\.batch_alter_table\(\s*["'](\w+)["']|batch(?:_op)?\.(add|drop)_column\(\s*/g;
    let currentBatchTable = null;
    let bm;
    while ((bm = batchRe.exec(up))) {
      if (bm[1]) {
        currentBatchTable = bm[1];
        if (!tables.has(currentBatchTable)) tables.set(currentBatchTable, new Set());
        continue;
      }
      if (!currentBatchTable) continue;
      const openIdx = up.indexOf('(', bm.index);
      const closeIdx = matchParen(up, openIdx);
      const col = stringsInCall(up, batchRe.lastIndex, closeIdx)[0];
      if (!col) continue;
      if (bm[2] === 'add') tables.get(currentBatchTable).add(col);
      else tables.get(currentBatchTable).delete(col);
    }
  }
  return tables;
}

// ---------- 本地 schema.ts 解析 ----------
function parseLocalSchema() {
  const text = readFileSync(join(ROOT, 'src/db/schema.ts'), 'utf8');
  const tables = new Map();

  // 每条 DDL 是一个模板字符串：await db.prepare(`...CREATE TABLE...`).run();
  for (const m of text.matchAll(/`([\s\S]*?)`\)\.run\(\);/g)) {
    const ddl = m[1];
    const nameM = ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (!nameM) continue;
    const name = nameM[1];
    const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
    const cols = new Set();
    for (const line of body.split('\n')) {
      const cm = line.match(/^\s*([a-z_]\w*)\s+(TEXT|INTEGER|REAL|NUMERIC|BLOB|BOOLEAN)\b/i);
      if (cm) cols.add(cm[1]);
    }
    tables.set(name, cols);
  }
  for (const m of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) {
    if (!tables.has(m[1])) tables.set(m[1], new Set());
    tables.get(m[1]).add(m[2]);
  }
  for (const m of text.matchAll(/safeAddColumn\('(\w+)',\s*'(\w+)'/g)) {
    if (!tables.has(m[1])) tables.set(m[1], new Set());
    tables.get(m[1]).add(m[2]);
  }
  for (const m of text.matchAll(/DROP TABLE IF EXISTS (\w+)/g)) tables.delete(m[1]);
  return tables;
}

// ---------- 对比 ----------
const up = parseUpstreamSchema();
const local = parseLocalSchema();
if (process.env.DEBUG_UP) {
  console.log('=== 上游解析结果 ===');
  for (const [k, v] of [...up.entries()].sort()) console.log(`${k}: ${[...v].join(',')}`);
  console.log('=== 本地解析结果 ===');
  for (const [k, v] of [...local.entries()].sort()) console.log(`${k}: ${[...v].join(',')}`);
}

const allTables = new Set([...up.keys(), ...local.keys()]);
const report = { fail: [], warn: [], info: [], ok: [] };

for (const t of [...allTables].sort()) {
  const upCols = up.get(t);
  const loCols = local.get(t);

  if (!upCols) {
    if (KNOWN.oursOnlyTables.has(t)) { report.info.push(`[仅我们] ${t}`); continue; }
    report.fail.push(`[仅我们(白名单外)] ${t}`);
    continue;
  }
  if (!loCols) {
    report.fail.push(`[仅上游!! 我们缺表] ${t}`);
    continue;
  }

  const missing = [...upCols].filter(c => !loCols.has(c)).sort();
  const extra = [...loCols].filter(c => !upCols.has(c)).sort();

  const knownMissing = (KNOWN.columnMissing[t] ?? []);
  const knownExtra = (KNOWN.columnAdditions[t] ?? []);
  const unexpectedMissing = missing.filter(c => !knownMissing.includes(c));
  const unexpectedExtra = extra.filter(c => !knownExtra.includes(c));

  if (unexpectedMissing.length || unexpectedExtra.length) {
    report.fail.push(`[${t}] 意外差异 少:${unexpectedMissing.join(',') || '-'} 多:${unexpectedExtra.join(',') || '-'}`);
  } else if (missing.length || extra.length) {
    report.warn.push(`[${t}] 已知差异 少:${missing.join(',') || '-'} 多:${extra.join(',') || '-'}`);
  } else {
    report.ok.push(`[${t}] 一致`);
  }
}

// ---------- 输出 ----------
const line = (s) => console.log(s);
line(`上游: ${UPSTREAM_REF}（${up.size} 表）  本地: src/db/schema.ts（${local.size} 表）`);
line('');
line('=== 完全一致 ===');
line(report.ok.join('\n') || '(无)');
line('');
line('=== 已知差异（白名单内，有意为之）===');
line(report.warn.join('\n') || '(无)');
line('');
line('=== 仅我们的扩展表 ===');
line(report.info.join('\n') || '(无)');
line('');
line('=== 需要跟进的新差异 ===');
line(report.fail.join('\n') || '(无)');
line('');

if (report.fail.length) {
  console.error(`✗ 发现 ${report.fail.length} 处未列入白名单的差异，需跟进处理（更新 schema.ts 或加入白名单）。`);
  process.exit(1);
} else {
  console.log(`✓ 结构核对通过：核心表与上游一致，${report.warn.length} 处已知差异、${report.info.length} 张扩展表（均在白名单内）。`);
}
