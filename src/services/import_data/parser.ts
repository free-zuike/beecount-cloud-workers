/**
 * 主解析器 — 对齐原版 Python services/import_data/parser.py
 * CSV/TSV 文本 → ImportData（headers + rows + suggested mapping）
 */

import type { SourceFormat, ImportData, ParsedRow, ImportFieldMapping } from './schema';
import { makeDefaultMapping } from './schema';
import { BeeCountParser } from './parsers/beecount';
import { GenericParser } from './parsers/generic';

const PARSERS: Record<string, BeeCountParser | GenericParser> = {
  beecount: new BeeCountParser(),
  generic: new GenericParser(),
};

export function detectSourceFormat(rawText: string): SourceFormat {
  const sample = rawText.slice(0, 5000).toLowerCase();
  if (new BeeCountParser().sniff(sample)) return 'beecount';
  return 'generic';
}

export function parseCsvText(rawText: string, forcedSource?: SourceFormat): ImportData {
  const cleaned = stripBomAndNormalize(rawText);
  const rows2d = parseCsvRows(cleaned);
  return buildImportData(rows2d, forcedSource);
}

export function suggestMapping(headers: string[], source: SourceFormat): ImportFieldMapping {
  const parser = PARSERS[source] || PARSERS.generic;
  return parser.suggestMapping(headers);
}

// ==================== Internal Helpers ====================

function stripBomAndNormalize(text: string): string {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseCsvRows(text: string): string[][] {
  if (!text.trim()) return [];
  const lines = text.split('\n');
  return lines
    .filter(line => line.trim())
    .map(line => parseCsvLine(line));
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function buildImportData(rows2d: string[][], forcedSource?: SourceFormat): ImportData {
  if (!rows2d.length) {
    return {
      sourceFormat: 'generic',
      headers: [],
      rows: [],
      suggestedMapping: makeDefaultMapping(),
      parseWarnings: [],
    };
  }

  let source: SourceFormat;
  if (forcedSource) {
    source = forcedSource;
  } else {
    const sampleLower = rows2d.slice(0, 30).map(r => r.join(',')).join('\n').toLowerCase();
    source = new BeeCountParser().sniff(sampleLower) ? 'beecount' : 'generic';
  }

  const parser = PARSERS[source] || PARSERS.generic;
  const headerIndex = parser.findHeaderRow(rows2d);
  const actualHeaderIndex = headerIndex < 0 || headerIndex >= rows2d.length ? 0 : headerIndex;

  const headersRaw = rows2d[actualHeaderIndex];
  const headers = headersRaw.map(h => String(h).trim());
  const dataRows2d = rows2d.slice(actualHeaderIndex + 1);

  const parsedRows: ParsedRow[] = [];
  const warnings: { code: string; rowNumber: number; message: string; rawLine?: string }[] = [];
  const expectedCols = headers.length;

  for (let offset = 0; offset < dataRows2d.length; offset++) {
    const rawCells = dataRows2d[offset];
    const rowNumber = actualHeaderIndex + 2 + offset;

    if (!rawCells.length || rawCells.every(c => (c || '').trim() === '')) continue;

    let cells: string[];
    if (rawCells.length !== expectedCols) {
      warnings.push({
        code: 'COLUMN_COUNT_MISMATCH',
        rowNumber,
        message: `got ${rawCells.length} columns, header has ${expectedCols}`,
        rawLine: rawCells.join(','),
      });
      cells = [...rawCells];
      if (cells.length < expectedCols) {
        while (cells.length < expectedCols) cells.push('');
      } else {
        cells = cells.slice(0, expectedCols);
      }
    } else {
      cells = [...rawCells];
    }

    const cellDict: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      cellDict[headers[i]] = cells[i] ?? '';
    }

    parsedRows.push({
      rowNumber,
      cells: cellDict,
      rawLine: rawCells.join(','),
    });
  }

  const suggested = suggestMapping(headers, source);

  return {
    sourceFormat: source,
    headers,
    rows: parsedRows,
    suggestedMapping: suggested,
    parseWarnings: warnings,
  };
}