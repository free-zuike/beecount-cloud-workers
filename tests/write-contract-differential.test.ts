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
  // tags：workers union(string|array) ≈ 上游 list[str]；happened_at：workers union(string|date) ≈ 上游 datetime
  return (s.has('array') && s.has('union')) || (s.has('datetime') && s.has('union'));
}

const GOLDEN = join(__dirname, 'fixtures', 'upstream-write-schema-golden.json');
const hasGolden = existsSync(GOLDEN);

describe('write request contract differential (workers zod vs upstream pydantic)', () => {
  it('golden fixture 已生成（CI 产出 upstream-write-schema-golden.json）', () => {
    expect(hasGolden, '缺少 golden：请等 CI 生成后提交 fixtures/upstream-write-schema-golden.json').toBe(true);
  });

  if (hasGolden) {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
      models: Record<string, Record<string, FieldInfo>>;
    };
    const labels = Object.keys(golden.models);

    it('workers 导出写请求 schema 覆盖全部模型', () => {
      for (const label of labels) {
        expect((writeRequestSchemas as any)[label], `workers 缺少写模型 ${label}`).toBeTruthy();
      }
    });

    for (const label of labels) {
      it(`[${label}] 字段契约与上游一致`, () => {
        const up = golden.models[label];
        const wk = describeZod((writeRequestSchemas as any)[label]);
        // 归一到逻辑字段名（snake）；同名去重（workers 常同时接受 currency_code / currencyCode 等别名）
        const wkNorm: Record<string, FieldInfo> = {};
        for (const [k, info] of Object.entries(wk)) {
          const key = camelToSnake(k);
          if (!wkNorm[key]) wkNorm[key] = info;
        }
        const fields = new Set([...Object.keys(up), ...Object.keys(wkNorm)]);
        const divergences: string[] = [];
        for (const f of fields) {
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
            divergences.push(`${f}: 必填性分歧 (up=${u.required}, wk=${w.required})`);
          }
          if (!typeCompatible(u.type, w.type)) {
            divergences.push(`${f}: 类型分歧 (up=${u.type}, wk=${w.type})`);
          }
        }
        expect(divergences.length ? divergences.join('\n') : '', '').toBe('');
      });
    }
  }
});
