type Row = Record<string, unknown>;

type MockResult = {
  success: boolean;
  meta: { last_row_id: number; changes: number };
  results: Row[];
};

type MockStatement = {
  bind(...args: unknown[]): MockStatement;
  run(): Promise<MockResult>;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
};

let autoIncrementId = 1;

function resetAutoIncrement() {
  autoIncrementId = 1;
}

class InMemoryDB {
  public tables: Map<string, Row[]> = new Map();

  getTable(name: string): Row[] {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
    return this.tables.get(name)!;
  }

  execute(sql: string, bindParams: unknown[] = []): MockResult {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('CREATE TABLE')) {
      const match = trimmed.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
      if (match) this.getTable(match[1]);
      return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };
    }
    if (upper.startsWith('CREATE INDEX')) {
      return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };
    }
    if (upper.startsWith('INSERT')) return this.handleInsert(trimmed, bindParams);
    if (upper.startsWith('UPDATE')) return this.handleUpdate(trimmed, bindParams);
    if (upper.startsWith('DELETE')) return this.handleDelete(trimmed, bindParams);
    if (upper.startsWith('SELECT')) return this.handleSelect(trimmed, bindParams);

    return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };
  }

  private handleInsert(sql: string, params: unknown[]): MockResult {
    // 支持 INSERT / INSERT OR IGNORE / INSERT OR REPLACE / INSERT INTO
    const tableMatch = sql.match(/INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?(?:INTO\s+)?(\w+)/i);
    if (!tableMatch) return { success: false, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const tableName = tableMatch[1];
    const table = this.getTable(tableName);

    const colsMatch = sql.match(/\(([^)]+)\)\s+(?:ON\s+CONFLICT[^)]+\)\s+)?VALUES/i);
    const valsMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
    if (!colsMatch || !valsMatch) return { success: false, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const columns = colsMatch[1].split(',').map(c => c.trim());
    const valueParts = valsMatch[1].split(',').map(v => v.trim());

    const isOnConflict = sql.toUpperCase().includes('ON CONFLICT');
    const isIgnore = sql.toUpperCase().includes('OR IGNORE');
    const isReplace = sql.toUpperCase().includes('OR REPLACE');

    const paramIdx = { current: 0 };
    const row: Row = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const val = i < valueParts.length ? valueParts[i] : '?';

      if (val === '?') {
        row[col] = params[paramIdx.current++];
      } else if (val.toUpperCase() === 'NULL') {
        row[col] = null;
      } else if (val.toUpperCase().startsWith('STRFTIME')) {
        row[col] = new Date().toISOString();
      } else if (val.toUpperCase() === 'DEFAULT') {
        row[col] = null;
      } else {
        row[col] = val.replace(/^'(.*)'$/, '$1');
      }
    }

    if (isIgnore) {
      const pkCol = columns[0];
      if (table.some(r => r[pkCol] === row[pkCol])) {
        return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };
      }
    }

    if (isReplace) {
      // SQLite INSERT OR REPLACE：同 PK 时先删旧行再插新行
      const pkCol = columns[0];
      const existing = table.findIndex(r => r[pkCol] === row[pkCol]);
      if (existing >= 0) {
        table.splice(existing, 1);
      }
    }

    if (isOnConflict) {
      const pkCol = columns[0];
      const existing = table.findIndex(r => r[pkCol] === row[pkCol]);
      if (existing >= 0) {
        const updatePart = sql.match(/DO\s+UPDATE\s+SET\s+(.+?)(?:\s*$)/is);
        if (updatePart) {
          const setClauses = this.parseSetClauses(updatePart[1]);
          for (const [col, valExpr] of Object.entries(setClauses)) {
            if (valExpr === '?') {
              table[existing][col] = params[paramIdx.current++];
            } else if (valExpr.toUpperCase() === 'NULL') {
              table[existing][col] = null;
            } else {
              table[existing][col] = valExpr.replace(/^'(.*)'$/, '$1');
            }
          }
        }
        return { success: true, meta: { last_row_id: 0, changes: 1 }, results: [] };
      }
    }

    table.push(row);
    // sync_changes 的 change_id 是 auto-increment，INSERT 不显式传该列，
    // 但后续 SELECT MAX(change_id) 需要行里有这个值。把 last_row_id 也写进去。
    if (tableName === 'sync_changes') {
      row['change_id'] = autoIncrementId;
    }
    return { success: true, meta: { last_row_id: autoIncrementId++, changes: 1 }, results: [] };
  }

  private handleUpdate(sql: string, params: unknown[]): MockResult {
    const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
    if (!tableMatch) return { success: false, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const tableName = tableMatch[1];
    const table = this.getTable(tableName);

    const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE|$)/is);
    if (!setMatch) return { success: false, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const setClauses = this.parseSetClauses(setMatch[1]);
    const whereClause = this.parseWhereClause(sql);
    const paramIdx = { current: 0 };

    let changes = 0;
    for (const row of table) {
      paramIdx.current = 0;
      if (whereClause && !this.matchesWhere(row, whereClause, params, paramIdx)) {
        continue;
      }
      for (const [col, valExpr] of Object.entries(setClauses)) {
        if (valExpr === '?') {
          row[col] = params[paramIdx.current++];
        } else if (valExpr.toUpperCase() === 'NULL') {
          row[col] = null;
        } else {
          row[col] = valExpr.replace(/^'(.*)'$/, '$1');
        }
      }
      changes++;
    }

    return { success: true, meta: { last_row_id: 0, changes }, results: [] };
  }

  private handleDelete(sql: string, params: unknown[]): MockResult {
    const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!tableMatch) return { success: false, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const tableName = tableMatch[1];
    const table = this.getTable(tableName);
    const whereClause = this.parseWhereClause(sql);
    const paramIdx = { current: 0 };

    if (!whereClause) {
      const len = table.length;
      this.tables.set(tableName, []);
      return { success: true, meta: { last_row_id: 0, changes: len }, results: [] };
    }

    const before = table.length;
    const remaining = table.filter(row => {
      paramIdx.current = 0;
      return !this.matchesWhere(row, whereClause, params, paramIdx);
    });
    this.tables.set(tableName, remaining);
    return { success: true, meta: { last_row_id: 0, changes: before - remaining.length }, results: [] };
  }

  private handleSelect(sql: string, params: unknown[]): MockResult {
    const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/i);
    if (!selectMatch) return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const selectExpr = selectMatch[1].trim();
    const tableName = selectMatch[2];
    const table = this.getTable(tableName);

    const hasJoin = /\bJOIN\b/i.test(sql);
    let workingRows: Row[] = hasJoin ? this.handleJoin(sql, [...table], tableName, params) : [...table];

    const whereClause = this.parseWhereClause(sql);
    const paramIdx = { current: 0 };
    if (whereClause) {
      workingRows = workingRows.filter(row => {
        paramIdx.current = 0;
        return this.matchesWhere(row, whereClause, params, paramIdx);
      });
    }

    const isDistinct = selectExpr.toUpperCase().startsWith('DISTINCT ');
    if (isDistinct) {
      const cols = this.parseSelectColumns(selectExpr.replace(/^DISTINCT\s+/i, ''));
      const seen = new Set<string>();
      workingRows = workingRows.filter(row => {
        const key = cols.map(c => String(row[c] ?? '')).join('||');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:\s+LIMIT|\s+OFFSET|$)/i);
    if (orderMatch) {
      workingRows = this.applyOrderBy(workingRows, orderMatch[1]);
    }

    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1]) : undefined;
    const offset = offsetMatch ? parseInt(offsetMatch[1]) : 0;

    if (limit !== undefined) {
      workingRows = workingRows.slice(offset, offset + limit);
    } else if (offset > 0) {
      workingRows = workingRows.slice(offset);
    }

    let results: Row[];
    if (selectExpr.toUpperCase().startsWith('MAX(')) {
      const colMatch = selectExpr.match(/MAX\((\w+)\)/i);
      if (colMatch) {
        const col = colMatch[1];
        const alias = selectExpr.match(/AS\s+(\w+)/i);
        const resultKey = alias ? alias[1] : colMatch[0].replace(/[()]/g, '').replace('MAX', '').trim();
        const maxVal = workingRows.reduce((max, row) => {
          const val = row[col];
          if (val === null || val === undefined) return max;
          const num = typeof val === 'number' ? val : parseInt(String(val), 10);
          return !isNaN(num) && num > max ? num : max;
        }, -Infinity);
        results = [{ [resultKey]: maxVal === -Infinity ? null : maxVal }];
      } else {
        results = workingRows;
      }
    } else if (selectExpr.toUpperCase().includes('COUNT(')) {
      const aliasMatch = selectExpr.match(/AS\s+(\w+)/i);
      const alias = aliasMatch ? aliasMatch[1] : 'count';
      results = [{ [alias]: workingRows.length }];
    } else if (selectExpr.toUpperCase().startsWith('LAST_INSERT_ROWID(')) {
      results = [{ id: autoIncrementId - 1 }];
    } else {
      const cols = this.parseSelectColumns(selectExpr);
      results = workingRows.map(row => {
        if (cols.includes('*')) return { ...row };
        const projected: Row = {};
        // 逐个解析 select 项：字面量 AS alias 直接赋值，列引用取行值
        const items = selectExpr.split(',').map(s => s.trim());
        for (const item of items) {
          const parts = item.split(/\s+AS\s+/i);
          if (parts.length > 1) {
            const raw = parts[0].trim();
            const alias = parts[1].trim();
            if (/^'[^']*'$/.test(raw)) {
              projected[alias] = raw.replace(/^'|'$/g, '');
            } else {
              projected[alias] = row[raw.split('.').pop()!.replace(/^'|'$/g, '')];
            }
          } else {
            const col = item.split('.').pop()!.replace(/^'|'$/g, '');
            projected[col] = row[col];
          }
        }
        return projected;
      });
    }

    return { success: true, meta: { last_row_id: 0, changes: 0 }, results };
  }

  private handleJoin(sql: string, baseTable: Row[], baseTableName: string, params: unknown[]): Row[] {
    const joinMatches = [...sql.matchAll(/(?:LEFT\s+)?JOIN\s+(\w+)\s+(?:AS\s+)?(\w+)?\s+ON\s+(.+?)(?=\s+(?:LEFT\s+)?JOIN|\s+WHERE|\s+ORDER|\s+LIMIT|$)/gi)];

    let result = baseTable;
    for (const joinMatch of joinMatches) {
      const joinTableName = joinMatch[1];
      const joinTable = this.getTable(joinTableName);
      const joinCondition = joinMatch[3].trim();
      const isLeftJoin = joinMatch[0].toUpperCase().startsWith('LEFT');

      const newResult: Row[] = [];
      for (const baseRow of result) {
        let matched = false;
        for (const joinRow of joinTable) {
          const parts = joinCondition.split('=').map(s => s.trim());
          if (parts.length !== 2) continue;

          const leftCol = parts[0].split('.').pop()!;
          const rightCol = parts[1].split('.').pop()!;

          const leftVal = baseRow[leftCol] ?? null;
          const rightVal = joinRow[rightCol] ?? null;

          if (leftVal === rightVal) {
            newResult.push({ ...baseRow, ...joinRow });
            matched = true;
          }
        }
        if (!matched && isLeftJoin) {
          newResult.push({ ...baseRow });
        }
      }
      result = newResult;
    }
    return result;
  }

  private parseSelectColumns(expr: string): string[] {
    if (expr.trim() === '*') return ['*'];
    return expr.split(',').map(c => {
      const parts = c.trim().split(/\s+AS\s+/i);
      const raw = parts[0].trim();
      // 字面量 AS alias（如 'owner' as role）→ 用 alias 名
      if (parts.length > 1 && /^'[^']*'$/.test(raw)) {
        return parts[1].trim();
      }
      return raw.split('.').pop()!.replace(/^'|'$/g, '');
    });
  }

  private parseSetClauses(setStr: string): Record<string, string> {
    const result: Record<string, string> = {};
    const parts = setStr.split(',');
    for (const part of parts) {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) continue;
      const col = part.substring(0, eqIndex).trim();
      const val = part.substring(eqIndex + 1).trim();
      if (val.toUpperCase() === 'NULL') {
        result[col] = 'NULL';
      } else if (val === '?') {
        result[col] = '?';
      } else {
        result[col] = val.replace(/^'(.*)'$/, '$1');
      }
    }
    return result;
  }

  private parseWhereClause(sql: string): string | null {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|\s+OFFSET|$)/is);
    return whereMatch ? whereMatch[1].trim() : null;
  }

  private matchesWhere(row: Row, where: string, params: unknown[], paramIdx: { current: number }): boolean {
    return this.evalBoolExpr(row, where, params, paramIdx);
  }

  /**
   * 递归下降布尔表达式求值器：正确处理 AND / OR / 括号 优先级。
   * pull 查询形如 ((A AND B AND C) OR (D AND E AND F))，旧实现只支持顶层 OR，
   * 遇到 OR 分支内嵌 AND 会忽略后半段 → 误判。这里按真 SQL 语义解析。
   * 叶子谓词（比较/IN/IS NULL/LIKE）交给 evaluateCondition。
   */
  private evalBoolExpr(row: Row, expr: string, params: unknown[], paramIdx: { current: number }): boolean {
    let pos = 0;
    const len = expr.length;

    const skipWs = () => { while (pos < len && /\s/.test(expr[pos])) pos++; };
    const parseOr = (): boolean => {
      let left = parseAnd();
      while (true) {
        skipWs();
        if (expr.slice(pos, pos + 2).toUpperCase() !== 'OR' || /\w/.test(expr[pos - 1] || '')) break;
        // 确保是独立 OR 关键字（前面是空格/括号）
        if (pos > 0 && !/\s|\)/.test(expr[pos - 1])) break;
        pos += 2;
        const right = parseAnd();
        left = left || right;
      }
      return left;
    };
    const parseAnd = (): boolean => {
      let left = parseUnary();
      while (true) {
        skipWs();
        if (expr.slice(pos, pos + 3).toUpperCase() !== 'AND' || /\w/.test(expr[pos - 1] || '')) break;
        if (pos > 0 && !/\s|\)/.test(expr[pos - 1])) break;
        pos += 3;
        const right = parseUnary();
        left = left && right;
      }
      return left;
    };
    const parseUnary = (): boolean => {
      skipWs();
      if (expr[pos] === '(') {
        pos++;
        const inner = parseOr();
        skipWs();
        if (expr[pos] === ')') pos++;
        return inner;
      }
      // 单谓词：从当前位置取到下一个顶层 AND/OR/右括号
      const start = pos;
      let depth = 0;
      while (pos < len) {
        const ch = expr[pos];
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        else if (depth === 0 && (expr.slice(pos, pos + 3).toUpperCase() === 'AND' || expr.slice(pos, pos + 2).toUpperCase() === 'OR')) {
          // 判断是否为独立关键字（非列名的一部分如 'ORDER'）
          const word = expr.slice(pos, pos + 3).toUpperCase();
          const isOp = (word === 'AND' && !/\w/.test(expr[pos - 1] || '') && !/\w/.test(expr[pos + 3] || ''))
            || (word === 'OR ' && !/\w/.test(expr[pos - 1] || '') && !/\w/.test(expr[pos + 2] || ''));
          if (isOp) break;
        }
        pos++;
      }
      const predicate = expr.slice(start, pos).trim();
      return this.evaluateCondition(row, predicate, params, paramIdx);
    };

    return parseOr();
  }

  private resolveColValue(row: Row, expr: string): unknown {
    const trimmed = expr.trim();
    if (trimmed.toUpperCase().startsWith('LOWER(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(6, -1).trim().split('.').pop()!;
      const val = row[inner];
      return val != null ? String(val).toLowerCase() : null;
    }
    return row[trimmed.split('.').pop()!];
  }

  private evaluateCondition(row: Row, condition: string, params: unknown[], paramIdx: { current: number }): boolean {
    const orParts = condition.split(/\s+OR\s+/i);
    if (orParts.length > 1) {
      return orParts.some(part => this.evaluateCondition(row, part.trim(), params, paramIdx));
    }

    const parenMatch = condition.match(/^\((.+)\)$/s);
    if (parenMatch) {
      return this.evaluateCondition(row, parenMatch[1], params, paramIdx);
    }

    const isNullMatch = condition.match(/(.+?)\s+IS\s+(NOT\s+)?NULL/i);
    if (isNullMatch) {
      const leftVal = this.resolveColValue(row, isNullMatch[1]);
      const isNot = !!isNullMatch[2];
      return isNot ? leftVal !== null && leftVal !== undefined : leftVal === null || leftVal === undefined;
    }

    const inMatch = condition.match(/(.+?)\s+IN\s*\((.+)\)/i);
    if (inMatch) {
      const leftVal = this.resolveColValue(row, inMatch[1]);
      const valsStr = inMatch[2].trim();
      // 支持 IN (SELECT ...) 子查询
      if (valsStr.toUpperCase().startsWith('SELECT')) {
        const subResult = this.handleSelect(valsStr, params);
        const vals = subResult.results.map(r => Object.values(r)[0]);
        return vals.includes(leftVal as string);
      }
      const vals = valsStr.split(',').map(v => {
        const trimmed = v.trim();
        if (trimmed === '?') return params[paramIdx.current++];
        return trimmed.replace(/^'(.*)'$/, '$1');
      });
      return vals.includes(leftVal as string);
    }

    let eqMatch = condition.match(/(.+?)\s*(IS\s+NOT|!=|<>|=|==)\s*(\?|NULL|'[^']*'|\d+(?:\.\d+)?)/i);
    if (eqMatch) {
      const leftVal = this.resolveColValue(row, eqMatch[1]);
      const op = eqMatch[2].toUpperCase();
      let rightVal: unknown;
      if (eqMatch[3] === '?') {
        rightVal = params[paramIdx.current++];
      } else if (eqMatch[3].toUpperCase() === 'NULL') {
        rightVal = null;
      } else if (/^\d/.test(eqMatch[3])) {
        rightVal = parseFloat(eqMatch[3]);
      } else {
        rightVal = eqMatch[3].replace(/^'(.*)'$/, '$1');
      }

      switch (op) {
        case '=': case '==': return leftVal === rightVal;
        case '!=': case '<>': return leftVal !== rightVal;
        case 'IS NOT': return leftVal !== rightVal;
        case 'IS': return leftVal === rightVal;
      }
    }

    const gtMatch = condition.match(/(.+?)\s*([><]=?)\s*(\?|\d+(?:\.\d+)?)/);
    if (gtMatch) {
      const leftVal = this.resolveColValue(row, gtMatch[1]);
      const op = gtMatch[2];
      let rightVal: unknown;
      if (gtMatch[3] === '?') {
        rightVal = params[paramIdx.current++];
      } else {
        rightVal = parseFloat(gtMatch[3]);
      }
      const isDateLeft = typeof leftVal === 'string' && leftVal.includes('T');
      const isDateRight = typeof rightVal === 'string' && (rightVal as string).includes('T');
      if (isDateLeft || isDateRight) {
        const l = String(leftVal ?? '');
        const r = String(rightVal ?? '');
        switch (op) {
          case '>': return l > r;
          case '>=': return l >= r;
          case '<': return l < r;
          case '<=': return l <= r;
        }
      }
      const numLeft = Number(leftVal) || 0;
      const numRight = Number(rightVal) || 0;
      switch (op) {
        case '>': return numLeft > numRight;
        case '>=': return numLeft >= numRight;
        case '<': return numLeft < numRight;
        case '<=': return numLeft <= numRight;
      }
    }

    // 无法识别的谓词（如 datetime('now') 表达式、未支持的函数）→ 保守不匹配
    return false;
  }

  private applyOrderBy(rows: Row[], orderByStr: string): Row[] {
    const parts = orderByStr.split(',').map(p => p.trim());
    return [...rows].sort((a, b) => {
      for (const part of parts) {
        const match = part.match(/(.+?)(?:\s+(ASC|DESC))?$/i);
        if (!match) continue;
        const colExpr = match[1].trim();
        const dir = (match[2] || 'ASC').toUpperCase();
        const aVal = this.resolveColValue(a, colExpr);
        const bVal = this.resolveColValue(b, colExpr);

        if (aVal === bVal) continue;
        if (aVal === null || aVal === undefined) return dir === 'ASC' ? -1 : 1;
        if (bVal === null || bVal === undefined) return dir === 'ASC' ? 1 : -1;

        const cmp = String(aVal).localeCompare(String(bVal));
        return dir === 'ASC' ? cmp : -cmp;
      }
      return 0;
    });
  }
}

export function createMockDB(): D1Database {
  const db = new InMemoryDB();

  const prepare = (sql: string): MockStatement => {
    let boundParams: unknown[] = [];
    const statement: MockStatement = {
      bind(...args: unknown[]): MockStatement {
        boundParams = [...args];
        return statement;
      },
      async run(): Promise<MockResult> {
        return db.execute(sql, boundParams);
      },
      async first<T = Row>(): Promise<T | null> {
        const result = db.execute(sql, boundParams);
        return (result.results[0] as T) || null;
      },
      async all<T = Row>(): Promise<{ results: T[] }> {
        const result = db.execute(sql, boundParams);
        return { results: result.results as T[] };
      },
    };
    return statement;
  };

  const batch = async (statements: MockStatement[]): Promise<MockResult[]> => {
    const results: MockResult[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  };

  return {
    prepare,
    batch,
    exec: async () => ({ success: true }),
    dump: async () => new ArrayBuffer(0),
    _internal: db,
  } as unknown as D1Database;
}

export function resetDB(db: D1Database) {
  const internal = (db as any)._internal as InMemoryDB;
  internal.tables.clear();
  resetAutoIncrement();
}

export function getTable(db: D1Database, tableName: string): Row[] {
  const internal = (db as any)._internal as InMemoryDB;
  return internal.getTable(tableName);
}
