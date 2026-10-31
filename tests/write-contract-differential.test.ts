/**
 * Phase C：REST 写路径「契约级」差分。
 *
 * 背景：workers 的 REST 写路由用 camelCase + zod，上游用 snake_case + pydantic，两套
 * REST 线格式是**故意不同**的（workers 是 Cloudflare 重写，要对自家前端讲 camelCase）；
 * 且写入逻辑本身已被 MCP 差分覆盖（workers 写路由与 MCP 共用 transaction-service）。
 * 因此这里不比「请求/响应字节」，只比**契约**：每个写请求模型的字段名 / 是否必填 / 类型，
 * 捕捉 zod 与 pydantic 之间的必填性 / 类型分歧（如某字段一侧必填另一侧可选）。
 *
 * 不需要执行写操作、不需要种账本、不需要 DB —— 纯静态 introspection 比对。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeRequestSchemas } from '../src/routes/write';
import { twoFactorRequestSchemas } from '../src/routes/two_factor';
import {
  AdminUserCreateSchema, AdminUserPatchSchema, AdminUserPasswordChangeSchema,
  BackupCreateSchema, BackupRestoreSchema,
} from '../src/routes/admin';
import { AiAskSchema, AiParseTxTextSchema, AiTestProviderSchema } from '../src/routes/ai';

// 合并各子系统的写请求 schema（按 golden 的逻辑 label 取用）
const allRequestSchemas: Record<string, any> = {
  ...(writeRequestSchemas as Record<string, any>),
  twoFAConfirm: (twoFactorRequestSchemas as any).confirm,
  twoFAVerify: (twoFactorRequestSchemas as any).verify,
  twoFADisable: (twoFactorRequestSchemas as any).disable,
  twoFARegenerate: (twoFactorRequestSchemas as any).regenerate,
  adminUserCreate: AdminUserCreateSchema,
  adminUserPatch: AdminUserPatchSchema,
  adminPasswordChange: AdminUserPasswordChangeSchema,
  adminBackupCreate: BackupCreateSchema,
  adminBackupRestore: BackupRestoreSchema,
  aiAsk: AiAskSchema,
  aiParseTxText: AiParseTxTextSchema,
  aiTestProvider: AiTestProviderSchema,
};

type FieldInfo = { required: boolean; type: string };

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()).replace(/^_/, '');
}

function mapZodType(typeName: string): string {
  switch (typeName) {
    case 'ZodString': return 'str';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'bool';
    case 'ZodArray': return 'array';
    case 'ZodEnum': return 'enum';
    case 'ZodDate': return 'datetime';
    case 'ZodRecord':
    case 'ZodObject': return 'object';
    case 'ZodAny': return 'any';
    default: return typeName;
  }
}

function describeZod(schema: any): Record<string, FieldInfo> {
  const shape = schema.shape ?? {};
  const out: Record<string, FieldInfo> = {};
  for (const [k, raw] of Object.entries(shape)) {
    let z: any = raw;
    let optional = false;
    while (z && z._def) {
      const tn = z._def.typeName as string;
      if (tn === 'ZodOptional' || tn === 'ZodDefault') optional = true;
      if (tn === 'ZodArray') break; // 不展开数组元素类型（z.array(z.record(...)) 仍视为 array）
      const inner = z._def.innerType ?? z._def.schema ?? z._def.type;
      if (!inner || inner === z) break;
      z = inner;
    }
    let typeName = (z?._def?.typeName as string) ?? 'unknown';
    // union 成员判定：含 date → datetime；含 array → array；否则 union
    if (typeName === 'ZodUnion') {
      const opts: any[] = z._def.options ?? [];
      const names = opts.map((o) => o?._def?.typeName);
      if (names.includes('ZodDate')) typeName = 'datetime';
      else if (names.includes('ZodArray')) typeName = 'array';
    }
    out[k] = { required: !optional, type: mapZodType(typeName) };
  }
  return out;
}

function typeCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const s = new Set([a, b]);
  // union 是宽泛类型，与任何类型都视为兼容（字段具体承载由上游决定）
  if (s.has('union')) return true;
  // tags：workers union(string|array) ≈ 上游 list[str]；happened_at：workers union(string|date) ≈ 上游 datetime
  return (s.has('array') && s.has('union')) || (s.has('datetime') && s.has('union'));
}

// 传输/并发层字段：base_change_id（上游要求放 body，workers 服务端自行取最新 change_id）、
// device_id / request_id / idempotency_key / client_timestamp / change_id / server_timestamp 等，
// 两侧实现不同，不属于「业务契约」，不参与比对。
const TRANSPORT_FIELDS = new Set([
  'base_change_id', 'device_id', 'request_id', 'idempotency_key',
  'client_timestamp', 'change_id', 'server_timestamp', 'ledger_id', 'ledger_external_id',
]);

const GOLDEN = join(__dirname, 'fixtures', 'upstream-write-schema-golden.json');
const SUB_GOLDEN = join(__dirname, 'fixtures', 'upstream-subsystems-schema-golden.json');
const hasGolden = existsSync(GOLDEN);
const hasSubGolden = existsSync(SUB_GOLDEN);

function loadGolden(p: string): { models: Record<string, Record<string, FieldInfo>> } {
  if (!existsSync(p)) return { models: {} };
  return (JSON.parse(readFileSync(p, 'utf8')) as { models: Record<string, Record<string, FieldInfo>> });
}

const writeModels = loadGolden(GOLDEN).models;
const subModels = loadGolden(SUB_GOLDEN).models;
const allModels: Record<string, Record<string, FieldInfo>> = { ...writeModels, ...subModels };

describe('write request contract differential (workers zod vs upstream pydantic)', () => {
  it('golden fixture 已生成（CI 产出 upstream-*-schema-golden.json）', () => {
    expect(hasGolden && hasSubGolden, '缺少 golden：请等 CI 生成后提交 fixtures/upstream-*-schema-golden.json').toBe(true);
  });

  if (hasGolden && hasSubGolden) {
    const labels = Object.keys(allModels);

    it('workers 导出写请求 schema 覆盖全部模型', () => {
      for (const label of labels) {
        expect(allRequestSchemas[label], `workers 缺少写模型 ${label}`).toBeTruthy();
      }
    });

    for (const label of labels) {
      it(`[${label}] 字段契约与上游一致`, () => {
        const up = allModels[label];
        const wk = describeZod(allRequestSchemas[label]);
        // 归一到逻辑字段名（snake）；同名去重（workers 常同时接受 currency_code / currencyCode 等别名）
        const wkNorm: Record<string, FieldInfo> = {};
        for (const [k, info] of Object.entries(wk)) {
          const key = camelToSnake(k);
          if (!wkNorm[key]) wkNorm[key] = info;
        }
        const fields = new Set([...Object.keys(up), ...Object.keys(wkNorm)]);
        const divergences: string[] = [];
        const benign: string[] = [];
        for (const f of fields) {
          if (TRANSPORT_FIELDS.has(f)) continue;
          const u = up[f];
          const w = wkNorm[f];
          if (!u) {
            // workers 多出字段：仅当它必填时才算分歧（workers 要求上游不认识的字段）
            if (w.required) divergences.push(`+${f}: workers 多出必填字段 (type=${w.type})`);
            continue;
          }
          if (!w) {
            // workers 缺少字段：仅当上游必填时才算分歧（可选字段的差异是扩展/省略，非对齐 bug）
            if (u.required) divergences.push(`-${f}: workers 缺少必填字段 (up type=${u.type})`);
            continue;
          }
          if (u.required !== w.required) {
            if (w.required && !u.required) {
              // 危险：workers 比上游更严格（上游可选、workers 必填）→ 会拒绝上游合法请求
              divergences.push(`${f}: 必填性分歧 (up=${u.required}, wk=${w.required})`);
            } else {
              // 良性：workers 比上游宽松（上游必填、workers 可选）→ 仅记录，不失败
              benign.push(`${f}: workers 比上游宽松(上游必填, wk 可选)`);
            }
          }
          if (!typeCompatible(u.type, w.type)) {
            divergences.push(`${f}: 类型分歧 (up=${u.type}, wk=${w.type})`);
          }
        }
        if (benign.length) console.warn(`[${label}] 良性分歧(不失败): ${benign.join('; ')}`);
        expect(divergences.length ? divergences.join('\n') : '', '').toBe('');
      });
    }
  }
});
