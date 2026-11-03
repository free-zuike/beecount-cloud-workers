#!/usr/bin/env node
/**
 * Schema 同步核对脚本 —— 每次同步上游后运行：
 *   node scripts/check-schema-sync.mjs
 *
 * 对比 upstream/main 的 canonical schema（Alembic 迁移；新版回退 src/db/schema.ts）与我们的
 * src/db/schema.ts（D1/SQLite），逐项核对：
 *   - 表/列集合（核心同步表必须一致）
 *   - 列类型（Alembic 类型映射到 D1 类型后比较 kind：INTEGER/REAL/TEXT/BLOB）
 *   - NOT NULL 约束
 *   - 外键（FK 目标表.列）
 *   - 索引（按 表+列集合 语义比较）
 *   - 默认值（松散归一化后比较）
 * 服务端扩展按已知差异白名单放行。
 *
 * 退出码：0 = 无意外差异（白名单内差异仅提示）；1 = 有需要跟进的新差异。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_REF = process.env.UPSTREAM_REF || 'upstream/main';

// ---- 已知差异白名单（有意为之的服务端扩展）----
const KNOWN = {
  oursOnlyTables: new Set([
    'app_metadata',      // schema 版本跟踪（Workers 冷启动跳过 DDL）
    'system_settings',   // setup 向导 + 服务器时区（上游用环境变量）
    'settings',          // key-value 配置（S3 上传配置等）
    'ai_image_cache',    // 截图记账缓存（D1+R2 持久化，上游无）
    'backup_restores',   // 恢复任务（上游无恢复功能）
  ]),
  // 列级已知差异（上游有/我们没有，或反之），按表归并
  columnAdditions: {
    // 本地独有的附件分类列（Workers 附件归类用，上游无）
    attachment_files: ['attachment_kind'],
    // 本地扩展：账本月起始日（预算周期用，上游无）
    ledgers: ['month_start_day'],
    // 本地扩展：MCP 调用日志冗余 PAT 名（便于审计，上游无）
    mcp_call_logs: ['pat_name'],
    // 本地扩展：交易最后编辑人（审计，上游无）
    read_tx_projection: ['last_edited_by_user_id'],
    // 本地扩展：同步变更作用域（ledger/device，上游无）
    sync_changes: ['scope'],
  },
  columnMissing: {},
  // 类型/约束级已知差异：键为 "表.列"，值为原因（有意为之）
  typeExceptions: {
    // D1 没有原生 BOOLEAN/DOUBLE 等，本地用 INTEGER/REAL 表达，逻辑等价
  },
  // NOT NULL 已知差异（本地有意允许为空，尽管上游要求非空），键为 "表.列"
  notNullExceptions: {
    // 设备级同步变更（scope=device）ledger_id 可为空，上游要求非空但本地语义需要可空
    'sync_changes.ledger_id': '设备级变更 ledger_id 可为空',
  },
  // 默认值已知差异：本地在 DB 层提供默认值（上游交给应用层），键为 "表.列"
  defaultExceptions: {
    // 以下均属 Workers 移植的有意选择：D1 无 SQLAlchemy 的应用层 default，
    // 遂把合理的兜底默认值下沉到 DB 层，避免空值。
    'attachment_files.size_bytes': '本地兜底默认 0',
    'backup_artifacts.size_bytes': '本地兜底默认 0',
    'backup_runs.status': '本地初始 pending（上游 running，但写入时总显式覆盖）',
    'devices.name': "本地兜底 'Unknown Device'",
    'devices.platform': "本地兜底 'unknown'",
    'exchange_rate_cache.source': "本地兜底 'exchangerate-api.com'",
    'ledger_invites.target_role': "本地兜底 'editor'",
    'ledger_members.role': "本地兜底 'editor'",
    'read_budget_projection.enabled': '本地兜底 1',
    'read_budget_projection.source_change_id': '本地兜底 0',
    'read_tx_projection.amount': '本地兜底 0.0',
    'read_tx_projection.exclude_from_budget': '本地兜底 0',
    'read_tx_projection.exclude_from_stats': '本地兜底 0',
    'read_tx_projection.source_change_id': '本地兜底 0',
    'read_tx_projection.tx_index': '本地兜底 0',
    'sync_cursors.last_cursor': '本地兜底 0',
    'user_account_projection.hidden': '本地兜底 0',
    'user_profiles.avatar_version': '本地兜底 0',
    'user_profiles.income_is_red': '本地兜底 1',
    'users.is_admin': '本地兜底 0',
    'users.is_enabled': '本地兜底 1',
  },
  // 本地独有的索引（Workers 性能/查询需要，上游无），键为 "表:col1,col2"
  oursOnlyIndexes: {},
};

// ---------- 类型映射 ----------
const ALEMBIC_TYPE_RE = /sa\.(?:[\w.]+\.)?(Integer|BigInteger|SmallInteger|BigInt|String|Text|Unicode|UnicodeText|CHAR|VARCHAR|Character|Boolean|Bool|Float|Numeric|Decimal|Real|Double|DateTime|Date|Time|Timestamp|JSON|JSONB|LargeBinary|Binary|BLOB|Uuid|UUID)\b(\([^)]*\))?/i;
function mapType(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/^sa\.(integer|biginteger|smallinteger|bigint|bigint)/.test(s)) return 'INTEGER';
  if (/^sa\.(string|text|unicode|unicode_text|char|varchar|character)/.test(s)) return 'TEXT';
  if (/^sa\.(boolean|bool)/.test(s)) return 'INTEGER'; // SQLite 无原生布尔，存为 0/1
  if (/^sa\.(float|numeric|decimal|real|double)/.test(s)) return 'REAL';
  if (/^sa\.(datetime|date|time|timestamp)/.test(s)) return 'TEXT'; // D1 以 ISO 文本存时间
  if (/^sa\.(json|jsonb)/.test(s)) return 'TEXT';
  if (/^sa\.(largebinary|binary|blob)/.test(s)) return 'BLOB';
  if (/^sa\.(uuid)/.test(s)) return 'TEXT';
  return 'OTHER:' + raw;
}
function mapLocalType(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase();
  if (s === 'INTEGER' || s === 'INT' || s === 'BOOLEAN' || s === 'BOOL') return 'INTEGER';
  if (s === 'TEXT' || s === 'VARCHAR' || s === 'CHAR' || s === 'CLOB') return 'TEXT';
  if (s === 'REAL' || s === 'FLOAT' || s === 'NUMERIC' || s === 'DECIMAL') return 'REAL';
  if (s === 'BLOB') return 'BLOB';
  return 'OTHER:' + raw;
}
function typeKind(t, isLocal) {
  return isLocal ? mapLocalType(t) : mapType(t);
}

function normalizeDefault(d) {
  if (d == null) return null;
  let s = String(d).trim().replace(/\s+/g, ' ').toLowerCase();
  s = s.replace(/^\(|\)$/g, ''); // 去掉包裹括号
  // 去掉 sqlalchemy 文本包装
  s = s.replace(/^(sa\.text|sqlalchemy\.text|text)\(/i, '').replace(/^\(|\)$/g, '');
  s = s.replace(/^sa\.false\(\)$/i, '0').replace(/^sa\.true\(\)$/i, '1'); // 布尔 <-> 0/1
  s = s.replace(/['"]/g, ''); // 去掉所有引号
  // now 表达式（SQLite strftime / PG now() / CURRENT_TIMESTAMP）视为等价
  if (/(strftime|current_timestamp|func\.now|now\(\)|\bnow\b)/.test(s)) return 'NOW';
  return s;
}
// 时间戳类列的默认值：一侧为 NOW、另一侧为空也视为对齐（DB 默认 vs 应用层默认）
function defaultsEquivalent(ud, ld) {
  if (ud === ld) return true;
  const a = normalizeDefault(ud), b = normalizeDefault(ld);
  if (a === b) return true;
  if (a === 'NOW' || b === 'NOW') return true;
  return false;
}

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
function parseAlembicColumn(body) {
  const col = { name: null, type: null, notNull: false, fk: null, pk: false, def: null };
  const nameM = body.match(/["']([^"']+)["']/);
  if (nameM) col.name = nameM[1];
  const tM = body.match(ALEMBIC_TYPE_RE);
  if (tM) col.type = tM[0];
  if (/nullable\s*=\s*False/i.test(body)) col.notNull = true;
  const fkM = body.match(/sa\.ForeignKey\(\s*["']([\w.]+)["']/i);
  if (fkM) col.fk = fkM[1];
  if (/primary_key\s*=\s*True/i.test(body)) { col.pk = true; col.notNull = true; }
  const defM = body.match(/server_default\s*=\s*([^,]+)/i) || body.match(/default\s*=\s*([^,]+)/i);
  if (defM) col.def = defM[1].trim();
  return col;
}

function parseUpstreamSchema() {
  const files = execSync(`git ls-tree -r --name-only ${UPSTREAM_REF} -- alembic/versions`, { cwd: ROOT })
    .toString().trim().split('\n').filter(f => /\d{4}_.*\.py$/.test(f)).sort();

  if (files.length === 0) {
    const text = execSync(`git show ${UPSTREAM_REF}:src/db/schema.ts`, {
      cwd: ROOT, maxBuffer: 10 * 1024 * 1024,
    }).toString();
    return parseSchemaTs(text);
  }

  // tables: name -> { cols: Map(name->{type,notNull,fk,pk,def}), indexes: Set("c1,c2"), pks: Set }
  const tables = new Map();
  const ensure = (t) => { if (!tables.has(t)) tables.set(t, { cols: new Map(), indexes: new Set(), pks: new Set() }); return tables.get(t); };

  for (const file of files) {
    const full = execSync(`git show ${UPSTREAM_REF}:${file}`, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }).toString();
    const upStart = full.indexOf('def upgrade');
    const downStart = full.indexOf('def downgrade', upStart + 1);
    const up = downStart > upStart ? full.slice(upStart, downStart) : full.slice(upStart);

    // 表级：op.create_table / op.add_column / op.drop_table / op.drop_column
    const opRe = /(?<!\w)op\.(create_table|add_column|drop_table|drop_column)\(\s*/g;
    let m;
    while ((m = opRe.exec(up))) {
      const openIdx = up.indexOf('(', m.index);
      const closeIdx = matchParen(up, openIdx);
      const args = stringsInCall(up, opRe.lastIndex, closeIdx);
      const body = up.slice(openIdx + 1, closeIdx);
      if (m[1] === 'create_table') {
        const t = args[0];
        const tbl = ensure(t);
        // 解析每个 sa.Column(...)
        const colRe = /sa\.Column\(\s*/g;
        let cm;
        while ((cm = colRe.exec(body))) {
          const cOpen = body.indexOf('(', cm.index);
          const cClose = matchParen(body, cOpen);
          const cBody = body.slice(cOpen + 1, cClose);
          const col = parseAlembicColumn(cBody);
          if (col.name) tbl.cols.set(col.name, { type: col.type, notNull: col.notNull, fk: col.fk, pk: col.pk, def: col.def });
        }
        // 表级主键 / 外键 / 索引
        let pkM;
        const pkRe = /sa\.PrimaryKeyConstraint\(\s*([^)]*)\)/g;
        while ((pkM = pkRe.exec(body))) { for (const c of stringsInCall(pkM[1], 0, pkM[1].length)) tbl.pks.add(c); }
        let fkM;
        const fkRe = /sa\.ForeignKeyConstraint\(\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]/g;
        while ((fkM = fkRe.exec(body))) {
          const localCols = stringsInCall(fkM[1], 0, fkM[1].length);
          const refs = stringsInCall(fkM[2], 0, fkM[2].length);
          localCols.forEach((lc, i) => {
            const ref = refs[i];
            if (tbl.cols.has(lc)) tbl.cols.get(lc).fk = ref;
          });
        }
        let ixM;
        const ixRe = /sa\.Index\(\s*["'][^"']*["']\s*,([^)]*)\)/g;
        while ((ixM = ixRe.exec(body))) {
          const cols = stringsInCall(ixM[1], 0, ixM[1].length);
          if (cols.length) tbl.indexes.add(cols.slice().sort().join(','));
        }
      } else if (m[1] === 'add_column') {
        const t = args[0];
        const tbl = ensure(t);
        const cOpen = body.indexOf('sa.Column(');
        if (cOpen >= 0) {
          const cStart = body.indexOf('(', cOpen);
          const cClose = matchParen(body, cStart);
          const col = parseAlembicColumn(body.slice(cStart + 1, cClose));
          if (col.name) tbl.cols.set(col.name, { type: col.type, notNull: col.notNull, fk: col.fk, pk: col.pk, def: col.def });
        }
      } else if (m[1] === 'drop_column') {
        const t = args[0];
        const tbl = tables.get(t);
        if (tbl) tbl.cols.delete(args[1]);
      } else if (m[1] === 'drop_table') {
        tables.delete(args[0]);
      }
    }

    // op.create_index('name', 't', ['c1','c2'], unique=...)
    const idxRe = /(?<!\w)op\.create_index\(\s*/g;
    let im;
    while ((im = idxRe.exec(up))) {
      const openIdx = up.indexOf('(', im.index);
      const closeIdx = matchParen(up, openIdx);
      const args = stringsInCall(up, idxRe.lastIndex, closeIdx);
      // args: [name, table, [cols...], unique?]
      if (args.length >= 3) {
        const t = args[1];
        const cols = args.slice(2)
          .filter(a => !/^(true|false|unique)$/i.test(a))
          .map(c => c.toLowerCase().replace(/\s+(desc|asc)$/, ''));
        const tbl = ensure(t);
        if (cols.length) tbl.indexes.add(cols.slice().sort().join(','));
      }
    }
  }
  return tables;
}

// ---------- schema.ts 解析（本地 + 新版上游共用） ----------
function parseSchemaTs(text) {
  const tables = new Map();
  const ensure = (t) => { if (!tables.has(t)) tables.set(t, { cols: new Map(), indexes: new Set(), pks: new Set() }); return tables.get(t); };

  for (const m of text.matchAll(/`([\s\S]*?)`\)\.run\(\);/g)) {
    const ddl = m[1];
    const nameM = ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (name.endsWith('_new')) continue;
    const open = ddl.indexOf('(');
    const close = ddl.lastIndexOf(')');
    const body = ddl.slice(open + 1, close);
    const tbl = ensure(name);
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\b|CHECK\b|CONSTRAINT\b|KEY\b|INDEX\b)/i.test(line)) {
        if (/^PRIMARY\s+KEY/i.test(line)) {
          const pm = line.match(/\(([^)]*)\)/);
          if (pm) for (const c of pm[1].split(',')) tbl.pks.add(c.trim());
        }
        if (/^FOREIGN\s+KEY/i.test(line)) {
          const fm = line.match(/FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s*(\w+)\s*\(([^)]*)\)/i);
          if (fm) {
            const localC = fm[1].trim();
            const ref = `${fm[2]}.${fm[3].trim()}`;
            if (tbl.cols.has(localC)) tbl.cols.get(localC).fk = ref;
          }
        }
        continue;
      }
      if (/^\)/.test(line)) continue;
      const cm = line.match(/^([a-z_]\w*)\s+(TEXT|INTEGER|REAL|NUMERIC|BLOB|BOOLEAN)\b\s*(.*)$/i);
      if (!cm) continue;
      const col = { name: cm[1], type: cm[2].toUpperCase(), notNull: /\bNOT\s+NULL\b/i.test(cm[3]), fk: null, pk: false, def: null };
      if (/\bPRIMARY\s+KEY\b/i.test(cm[3])) { col.pk = true; col.notNull = true; }
      const fkM = cm[3].match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (fkM) col.fk = `${fkM[1]}.${fkM[2]}`;
      const defM = cm[3].match(/DEFAULT\s+((?:\([^)]*\)|'[^']*'|"[^"]*"|[^\s,]+))/i);
      if (defM) col.def = defM[1].trim();
      tbl.cols.set(col.name, col);
    }
  }
  for (const m of text.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi)) {
    const t = m[2];
    const cols = m[3].split(',').map(c => c.trim().toLowerCase().replace(/\s+(desc|asc)$/, '')).filter(Boolean);
    if (cols.length) ensure(t).indexes.add(cols.slice().sort().join(','));
  }
  for (const m of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) { if (!tables.has(m[1])) ensure(m[1]); if (!tables.get(m[1]).cols.has(m[2])) tables.get(m[1]).cols.set(m[2], { name: m[2], type: null, notNull: false, fk: null, pk: false, def: null }); }
  for (const m of text.matchAll(/safeAddColumn\('(\w+)',\s*'(\w+)'/g)) { if (!tables.has(m[1])) ensure(m[1]); if (!tables.get(m[1]).cols.has(m[2])) tables.get(m[1]).cols.set(m[2], { name: m[2], type: null, notNull: false, fk: null, pk: false, def: null }); }
  for (const m of text.matchAll(/DROP TABLE IF EXISTS (\w+)/g)) tables.delete(m[1]);
  return tables;
}

function parseLocalSchema() {
  return parseSchemaTs(readFileSync(join(ROOT, 'src/db/schema.ts'), 'utf8'));
}

// ---------- 对比 ----------
const up = parseUpstreamSchema();
const local = parseLocalSchema();
if (process.env.DEBUG_UP) {
  console.log('=== 上游解析 ===');
  for (const [k, v] of [...up.entries()].sort()) console.log(`${k}: cols=${[...v.cols.keys()].join(',')} idx=${[...v.indexes].join('|')}`);
  console.log('=== 本地解析 ===');
  for (const [k, v] of [...local.entries()].sort()) console.log(`${k}: cols=${[...v.cols.keys()].join(',')} idx=${[...v.indexes].join('|')}`);
}

const allTables = new Set([...up.keys(), ...local.keys()]);
const report = { fail: [], warn: [], info: [], ok: [], deep: [] };

const isKnownTypeException = (key) => Object.prototype.hasOwnProperty.call(KNOWN.typeExceptions, key);

for (const t of [...allTables].sort()) {
  const upT = up.get(t);
  const loT = local.get(t);

  if (!upT) {
    if (KNOWN.oursOnlyTables.has(t)) { report.info.push(`[仅我们] ${t}`); continue; }
    report.fail.push(`[仅我们(白名单外)] ${t}`);
    continue;
  }
  if (!loT) {
    report.fail.push(`[仅上游!! 我们缺表] ${t}`);
    continue;
  }

  const upCols = upT.cols, loCols = loT.cols;
  // 列集合
  const upNames = new Set(upCols.keys()), loNames = new Set(loCols.keys());
  const missing = [...upNames].filter(c => !loNames.has(c)).sort();
  const extra = [...loNames].filter(c => !upNames.has(c)).sort();
  const knownMissing = (KNOWN.columnMissing[t] ?? []);
  const knownExtra = (KNOWN.columnAdditions[t] ?? []);
  const unexpectedMissing = missing.filter(c => !knownMissing.includes(c));
  const unexpectedExtra = extra.filter(c => !knownExtra.includes(c));

  // 深层对比（共有列）
  const deepDiffs = [];
  for (const c of [...new Set([...upNames, ...loNames])].sort()) {
    const u = upCols.get(c), l = loCols.get(c);
    if (!u || !l) continue;
    const key = `${t}.${c}`;
    // 类型
    if (!isKnownTypeException(key)) {
      const uk = typeKind(u.type, false), lk = typeKind(l.type, true);
      if (uk && lk && uk !== lk) deepDiffs.push(`类型 ${c}: 上游${uk} vs 本地${lk}`);
    }
    // NOT NULL（主键隐含 NOT NULL，上下游都按 PK 计）
    const uNot = u.notNull || upT.pks.has(c);
    const lNot = l.notNull || loT.pks.has(c);
    if (!!uNot !== !!lNot && !KNOWN.notNullExceptions[key]) deepDiffs.push(`NOT NULL ${c}: 上游${uNot ? '是' : '否'} vs 本地${lNot ? '是' : '否'}`);
    // 外键
    if ((u.fk || null) !== (l.fk || null)) deepDiffs.push(`FK ${c}: 上游${u.fk || '-'} vs 本地${l.fk || '-'}`);
    // 默认值
    if (!defaultsEquivalent(u.def, l.def) && !KNOWN.defaultExceptions[key]) {
      const ud = normalizeDefault(u.def), ld = normalizeDefault(l.def);
      deepDiffs.push(`默认 ${c}: 上游${ud ?? '-'} vs 本地${ld ?? '-'}`);
    }
  }

  // 索引对比
  const upIdx = upT.indexes, loIdx = loT.indexes;
  const idxMissing = [...upIdx].filter(i => !loIdx.has(i)).sort(); // 上游有、本地无
  const idxExtra = [...loIdx].filter(i => !upIdx.has(i)).sort();   // 本地有、上游无
  const knownExtraIdx = Object.keys(KNOWN.oursOnlyIndexes).filter(k => k.startsWith(`${t}:`));
  const unexpectedIdxExtra = idxExtra.filter(i => !KNOWN.oursOnlyIndexes[`${t}:${i}`]);

  if (unexpectedMissing.length || unexpectedExtra.length) {
    report.fail.push(`[${t}] 列意外差异 少:${unexpectedMissing.join(',') || '-'} 多:${unexpectedExtra.join(',') || '-'}`);
  }
  if (idxMissing.length) {
    // 上游有索引本地无 → 应补齐（对齐）
    report.deep.push(`[${t}] 缺索引(上游有): ${idxMissing.join(' | ')}`);
  }
  if (unexpectedIdxExtra.length) {
    report.deep.push(`[${t}] 本地独有索引(上游无): ${unexpectedIdxExtra.join(' | ')}`);
  }
  if (deepDiffs.length) {
    report.deep.push(`[${t}] 约束差异: ${deepDiffs.join('; ')}`);
  }

  if (!unexpectedMissing.length && !unexpectedExtra.length && !deepDiffs.length && !idxMissing.length && !unexpectedIdxExtra.length) {
    report.ok.push(`[${t}] 一致`);
  } else if (!unexpectedMissing.length && !unexpectedExtra.length && (deepDiffs.length || idxMissing.length || unexpectedIdxExtra.length)) {
    report.warn.push(`[${t}] 已知/约束级差异`);
  }
}

// ---------- 输出 ----------
const line = (s) => console.log(s);
line(`上游: ${UPSTREAM_REF}（${up.size} 表）  本地: src/db/schema.ts（${local.size} 表）`);
line('');
line('=== 完全一致 ===');
line(report.ok.join('\n') || '(无)');
line('');
line('=== 约束/索引级差异（需复核对齐）===');
line(report.deep.join('\n') || '(无)');
line('');
line('=== 已知差异（白名单内，有意为之）===');
line(report.warn.join('\n') || '(无)');
line('');
line('=== 仅我们的扩展表 ===');
line(report.info.join('\n') || '(无)');
line('');
line('=== 需要跟进的新差异（列集合）===');
line(report.fail.join('\n') || '(无)');
line('');

if (report.fail.length) {
  console.error(`✗ 发现 ${report.fail.length} 处未列入白名单的列集合差异，需跟进处理（更新 schema.ts 或加入白名单）。`);
  process.exit(1);
} else {
  console.log(`✓ 结构核对通过：核心表与上游一致，${report.deep.length} 处约束/索引级差异待复核，${report.warn.length} 处已知差异、${report.info.length} 张扩展表（白名单内）。`);
}
