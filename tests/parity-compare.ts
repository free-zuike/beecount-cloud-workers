/**
 * 运行时差分的比对器（与上游 golden 对照）。
 *
 * 这里刻意不做"模糊匹配"：除了下面 `VOLATILE_KEYS` 里明确列出的易变字段（时间戳、修订号、
 * 数据源版本），其余字段一律 `===` 比较。宁可报假失败，也不要放过真差异。
 */

/** 每次运行必然不同、无法跨实例比较的字段（其余都要严格相等） */
const VOLATILE_KEYS = new Set([
  'revision',
  'last_change_id',
  'source_change_id',
  'generated_at',
  'created_at',
  'updated_at',
  'next_due_at',
  'file_sha256',
  'duration_ms',
  // 写路径：每次调用都新生成的请求 id 与服务器时钟
  'operation_id',
  'server_timestamp',
]);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 规范化：键排序、去掉易变字段、数字保持原值（不做四舍五入，避免掩盖精度差异） */
/**
 * 游标是 `<HMAC>.<base64url(JSON)>`。HMAC 的密钥两侧不同（各自环境变量/配置），
 * 所以整串必然不等；但 **payload 是契约**——里面的 filter/id/revision/time
 * 一旦走偏就是真差异。这里只保留解码后的 payload 参与比对。
 */
/**
 * 游标是 `base64url(HMAC-SHA256(32 字节) || JSON)`：前面是二进制签名，后面直接接
 * JSON 文本，**没有分隔符**。HMAC 的密钥两侧不同，所以整串必然不等；但 payload 里
 * 的 filter/id/revision/time 是契约。这里从首个 '{' 开始解析，只保留 payload。
 */
function decodeCursor(text: string): Json {
  try {
    const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // 签名是二进制，转成 utf8 会掺进乱码（可能也含 '{'），所以逐个 '{' 试解析，
    // 取第一个能解析成带 id/filter 的对象的位置
    for (let at = raw.indexOf('{'); at >= 0; at = raw.indexOf('{', at + 1)) {
      try {
        const payload = JSON.parse(raw.slice(at)) as { time?: unknown; id?: unknown; filter?: unknown };
        if (!payload || typeof payload !== 'object' || payload.id === undefined) continue;
        // 上游 SQLite 存 tz-naive datetime，payload.time 是 "2026-05-13T02:30:00"；
        // 本地列里是带 Z 的 ISO。后缀差异不是契约（游标对客户端不透明），
        // 但秒级时间值本身仍然参与比对。
        if (typeof payload.time === 'string') {
          payload.time = payload.time.replace(/Z$/, '').replace(/\+00:00$/, '');
        }
        return payload as Json;
      } catch {
        /* 这个 '{' 落在二进制区，继续找下一个 */
      }
    }
    return text;
  } catch {
    return text;
  }
}

export function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const v = value[key] as Json;
      out[key] = key.endsWith('cursor') && typeof v === 'string' ? normalize(decodeCursor(v)) : normalize(v);
    }
    return out;
  }
  return value;
}

export interface CaseDiff {
  path: string;
  upstream: Json | undefined;
  local: Json | undefined;
  reason: 'missing-in-local' | 'missing-in-upstream' | 'type' | 'value';
}

/** 递归比对，返回所有差异（不止第一条，便于一次看清） */
export function diffJson(upstream: Json, local: Json, path = '$'): CaseDiff[] {
  if (upstream === local) return [];
  const typeOf = (v: Json | undefined) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  if (typeOf(upstream) !== typeOf(local)) {
    return [{ path, upstream, local, reason: 'type' }];
  }
  if (Array.isArray(upstream) && Array.isArray(local)) {
    const out: CaseDiff[] = [];
    if (upstream.length !== local.length) {
      out.push({ path: `${path}.length`, upstream: upstream.length, local: local.length, reason: 'value' });
    }
    const n = Math.min(upstream.length, local.length);
    for (let i = 0; i < n; i += 1) out.push(...diffJson(upstream[i], local[i], `${path}[${i}]`));
    return out;
  }
  if (upstream && local && typeof upstream === 'object' && typeof local === 'object') {
    const up = upstream as { [k: string]: Json };
    const lo = local as { [k: string]: Json };
    const out: CaseDiff[] = [];
    for (const key of Object.keys(up)) {
      if (!(key in lo)) out.push({ path: `${path}.${key}`, upstream: up[key], local: undefined, reason: 'missing-in-local' });
      else out.push(...diffJson(up[key], lo[key], `${path}.${key}`));
    }
    for (const key of Object.keys(lo)) {
      if (!(key in up)) out.push({ path: `${path}.${key}`, upstream: undefined, local: lo[key], reason: 'missing-in-upstream' });
    }
    return out;
  }
  return [{ path, upstream, local, reason: 'value' }];
}

/** 把差异列表渲染成便于排查的多行文本 */
export function formatDiffs(tool: string, diffs: CaseDiff[]): string {
  const lines = [`[${tool}] ${diffs.length} 处差异`];
  for (const d of diffs.slice(0, 12)) {
    lines.push(`  ${d.path}  ${d.reason}: upstream=${JSON.stringify(d.upstream)} local=${JSON.stringify(d.local)}`);
  }
  if (diffs.length > 12) lines.push(`  …还有 ${diffs.length - 12} 处`);
  return lines.join('\n');
}
