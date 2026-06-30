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
  private tables: Map<string, Row[]> = new Map();

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
    const tableMatch = sql.match(/INSERT\s+(?:OR\s+IGNORE\s+)?(?:INTO\s+)?(\w+)/i);
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
    const remaining = table.filter(row => !this.matchesWhere(row, whereClause, params, paramIdx));
    this.tables.set(tableName, remaining);
    return { success: true, meta: { last_row_id: 0, changes: before - remaining.length }, results: [] };
  }

  private handleSelect(sql: string, params: unknown[]): MockResult {
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
    if (!selectMatch) return { success: true, meta: { last_row_id: 0, changes: 0 }, results: [] };

    const selectExpr = selectMatch[1].trim();
    const tableName = selectMatch[2];
    const table = this.getTable(tableName);

    const hasJoin = /\bJOIN\b/i.test(sql);
    let workingRows: Row[] = hasJoin ? this.handleJoin(sql, [...table], tableName, params) : [...table];

    const whereClause = this.parseWhereClause(sql);
    const paramIdx = { current: 0 };
    if (whereClause) {
      workingRows = workingRows.filter(row => this.matchesWhere(row, whereClause, params, paramIdx));
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
        for (const col of cols) {
          projected[col] = row[col];
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
      return parts[0].trim().split('.').pop()!;
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
    const conditions = this.splitWhereConditions(where);
    for (const condition of conditions) {
      if (!this.evaluateCondition(row, condition.trim(), params, paramIdx)) {
        return false;
      }
    }
    return true;
  }

  private splitWhereConditions(where: string): string[] {
    const conditions: string[] = [];
    let current = '';
    let inParen = 0;
    let inQuote = false;

    for (let i = 0; i < where.length; i++) {
      const ch = where[i];
      if (ch === "'" && (i === 0 || where[i - 1] !== '\\')) inQuote = !inQuote;
      if (!inQuote) {
        if (ch === '(') inParen++;
        if (ch === ')') inParen--;
        if (inParen === 0 && i + 4 <= where.length && where.substring(i, i + 4).toUpperCase() === ' AND') {
          conditions.push(current);
          current = '';
          i += 3;
          continue;
        }
      }
      current += ch;
    }
    if (current.trim()) conditions.push(current);
    return conditions;
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
      const valsStr = inMatch[2];
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

    return true;
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
