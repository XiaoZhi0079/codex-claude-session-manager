import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';

import { CleanerError } from './core.mjs';

const THREAD_TABLES = [
  'local_thread_catalog',
  'local_thread_catalog_scan_entries',
  'thread_timeline_ledger',
];

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new CleanerError(
      'SQLITE_UNAVAILABLE',
      'Updating the Codex desktop catalog requires Node.js 22.5 or newer with node:sqlite.',
      501,
      { cause: error.message },
    );
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function jsonSafeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? value.toString() : value,
  ]));
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readRows(db, table, sessionIds) {
  return db.prepare(
    `SELECT * FROM ${quoteIdentifier(table)} WHERE thread_id IN (${placeholders(sessionIds.length)}) ORDER BY thread_id`,
  ).all(...sessionIds).map(jsonSafeRow);
}

function readCatalogState(db, sessionIds) {
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  return THREAD_TABLES
    .filter((name) => existing.has(name))
    .map((name) => ({ name, rows: readRows(db, name, sessionIds) }))
    .filter((table) => table.rows.length > 0);
}

function sameTables(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function inspectCodexDesktopCatalog(codexHome, sessionIds) {
  const ids = [...new Set(sessionIds.map(String).filter(Boolean))];
  if (!ids.length) return { path: null, tables: [], rows: 0 };
  const databasePath = path.join(codexHome, 'sqlite', 'codex-dev.db');
  try {
    if (!(await stat(databasePath)).isFile()) return { path: null, tables: [], rows: 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: null, tables: [], rows: 0 };
    throw error;
  }
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const tables = readCatalogState(db, ids);
    return {
      path: databasePath,
      tables,
      rows: tables.reduce((total, table) => total + table.rows.length, 0),
    };
  } finally {
    db.close();
  }
}

export async function backupCodexDesktopCatalog(preview, backupDir) {
  if (!preview?.path || !preview.rows) return null;
  const sqlite = await loadSqlite();
  const targetDir = path.join(backupDir, 'desktop-catalog');
  const backupPath = path.join(targetDir, path.basename(preview.path));
  await mkdir(targetDir, { recursive: true });
  const source = new sqlite.DatabaseSync(preview.path, { readOnly: true });
  try {
    source.exec('PRAGMA busy_timeout=2000');
    await sqlite.backup(source, backupPath);
  } finally {
    source.close();
  }
  return { path: preview.path, backupPath, rows: preview.rows };
}

export async function applyCodexDesktopCatalogCleanup(preview, sessionIds) {
  if (!preview?.path || !preview.rows) return { tables: [], rows: 0 };
  const ids = [...new Set(sessionIds.map(String).filter(Boolean))];
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(preview.path);
  let transactionStarted = false;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const current = readCatalogState(db, ids);
    if (!sameTables(current, preview.tables)) {
      throw new CleanerError(
        'STALE_CODEX_DESKTOP_CATALOG',
        'The Codex desktop thread catalog changed after deletion preview.',
        409,
        { databasePath: preview.path },
      );
    }
    const deleted = [];
    for (const table of preview.tables) {
      const result = db.prepare(
        `DELETE FROM ${quoteIdentifier(table.name)} WHERE thread_id IN (${placeholders(ids.length)})`,
      ).run(...ids);
      deleted.push({ name: table.name, rows: Number(result.changes) });
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return { tables: deleted, rows: deleted.reduce((total, table) => total + table.rows, 0) };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function rollbackCodexDesktopCatalog(preview) {
  if (!preview?.path || !preview.rows) return [];
  const errors = [];
  let db;
  let transactionStarted = false;
  try {
    const sqlite = await loadSqlite();
    db = new sqlite.DatabaseSync(preview.path);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    for (const table of preview.tables) {
      for (const row of table.rows) {
        const columns = Object.keys(row);
        const result = db.prepare(
          `INSERT OR IGNORE INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders(columns.length)})`,
        ).run(...columns.map((column) => row[column]));
        if (Number(result.changes) !== 1) {
          errors.push({ target: `${preview.path}:${table.name}:${row.thread_id}`, message: 'A catalog row already exists.' });
        }
      }
    }
    db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    errors.push({ target: preview.path, message: error.message });
  } finally {
    db?.close();
  }
  return errors;
}
