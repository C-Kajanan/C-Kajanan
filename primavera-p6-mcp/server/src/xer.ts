// Parser for Primavera P6 XER export files.
//
// An XER file is tab-delimited text:
//   ERMHDR <version> <export date> ...      header line
//   %T <TABLE>                              start of a table
//   %F <field> <field> ...                  column names
//   %R <value> <value> ...                  one row
//   %E                                      end of file
// P6 writes it in the Windows code page of the exporting machine (usually
// Windows-1252), so we decode as UTF-8 only when the bytes are valid UTF-8.

import { readFileSync, statSync } from "node:fs";

export type Row = Record<string, string>;

export interface XerFile {
  path: string;
  version: string;
  exportDate: string;
  exportUser: string;
  tables: Map<string, Row[]>;
}

export class XerError extends Error {}

export function decodeXer(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function parseXer(text: string, path = "<memory>"): XerFile {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").split("\t");
  if (header[0] !== "ERMHDR") {
    throw new XerError(`${path} is not an XER file (first line should start with ERMHDR).`);
  }
  const tables = new Map<string, Row[]>();
  let fields: string[] = [];
  let rows: Row[] | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const tag = line.slice(0, 2);
    const parts = line.split("\t");
    if (tag === "%T") {
      rows = [];
      fields = [];
      tables.set(parts[1].trim(), rows);
    } else if (tag === "%F") {
      fields = parts.slice(1).map((f) => f.trim());
    } else if (tag === "%R" && rows) {
      const row: Row = {};
      for (let f = 0; f < fields.length; f++) row[fields[f]] = parts[f + 1] ?? "";
      rows.push(row);
    } else if (tag === "%E") {
      break;
    }
  }
  return { path, version: header[1] ?? "", exportDate: header[2] ?? "", exportUser: header[4] ?? "", tables };
}

const cache = new Map<string, { mtimeMs: number; size: number; xer: XerFile }>();

/** Load and parse an XER file, reusing the parsed copy until the file changes. */
export function loadXer(path: string): XerFile {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new XerError(`File not found: ${path}`);
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.xer;
  const xer = parseXer(decodeXer(readFileSync(path)), path);
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, xer });
  return xer;
}

export function table(xer: XerFile, name: string): Row[] {
  return xer.tables.get(name) ?? [];
}

/** XER dates look like "2024-03-18 08:00". Returns epoch ms or undefined. */
export function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value.trim());
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

export function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
