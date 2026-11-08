/**
 * 本地日 K 存档：突破在线接口约 2.6 年上限。上游 `astock_archive.py` 的 Node 移植。
 * 只存不复权原始价；口径 (code, date, adjust) 三段主键。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS bars (
    code        TEXT NOT NULL,
    date        TEXT NOT NULL,
    adjust      TEXT NOT NULL DEFAULT 'raw',
    open        REAL NOT NULL DEFAULT 0,
    close       REAL NOT NULL DEFAULT 0,
    high        REAL NOT NULL DEFAULT 0,
    low         REAL NOT NULL DEFAULT 0,
    volume_lot  REAL NOT NULL DEFAULT 0,
    amount      REAL,
    source      TEXT NOT NULL DEFAULT '',
    saved_at    TEXT NOT NULL,
    PRIMARY KEY (code, date, adjust)
);
CREATE INDEX IF NOT EXISTS idx_bars_date ON bars(date);
CREATE INDEX IF NOT EXISTS idx_bars_code ON bars(code, adjust, date);
CREATE TABLE IF NOT EXISTS archive_meta (
    code        TEXT NOT NULL,
    adjust      TEXT NOT NULL DEFAULT 'raw',
    first_date  TEXT NOT NULL DEFAULT '',
    last_date   TEXT NOT NULL DEFAULT '',
    bar_count   INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (code, adjust)
);
`;

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function humanSize(n) {
  if (n <= 0) return '0 B';
  let v = n;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return unit === 'B' ? `${Math.round(v)} B` : `${v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

export class Archive {
  constructor(dbPath) {
    this.path = path.resolve(String(dbPath));
    this._initDb();
  }

  _connect() {
    fs.mkdirSync(path.dirname(this.path) || '.', { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=10000');
    return db;
  }

  _db(fn) {
    const db = this._connect();
    try {
      db.exec('BEGIN');
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  _read(fn) {
    const db = this._connect();
    try { return fn(db); } finally { try { db.close(); } catch { /* ignore */ } }
  }

  _initDb() {
    const db = this._connect();
    try { db.exec(SQL_SCHEMA); } finally { db.close(); }
  }

  /** 批量写入日 K。返回 {saved, skipped, first_date, last_date}。 */
  saveBars(code, bars, adjust = 'raw', source = '') {
    const adj = ['raw', 'qfq', 'hfq'].includes(String(adjust).toLowerCase())
      ? String(adjust).toLowerCase() : 'raw';
    const rows = [];
    const now = nowStamp();
    for (const b of bars || []) {
      const date = String(b.date || '').trim();
      const close = b.close;
      if (!date || close === null || close === undefined || close <= 0) continue;
      const amount = b.amount_yuan !== undefined && b.amount_yuan !== null
        ? Number(b.amount_yuan)
        : (b.amount !== undefined && b.amount !== null ? Number(b.amount) : null);
      rows.push([
        code, date, adj,
        Number(b.open || close), Number(close), Number(b.high || close), Number(b.low || close),
        Number(b.volume_lot || 0), amount, source, now,
      ]);
    }
    if (!rows.length) return {
      saved: 0, skipped: 0, first_date: '', last_date: '',
    };

    const saved = this._db((db) => {
      let count = 0;
      for (const row of rows) {
        db.prepare(
          'INSERT OR REPLACE INTO bars'
          + '(code,date,adjust,open,close,high,low,volume_lot,amount,source,saved_at) '
          + 'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).run(...row);
        count += 1;
      }
      this._refreshMeta(db, code, adj);
      return count;
    });
    const dates = rows.map((r) => r[1]).sort();
    return {
      saved, skipped: rows.length - saved,
      first_date: dates[0], last_date: dates[dates.length - 1],
    };
  }

  _refreshMeta(db, code, adjust) {
    const row = db.prepare(
      'SELECT MIN(date) AS f, MAX(date) AS l, COUNT(*) AS n '
      + 'FROM bars WHERE code=? AND adjust=?',
    ).get(code, adjust);
    if (!row || !row.n) return;
    db.prepare(
      'INSERT OR REPLACE INTO archive_meta'
      + '(code,adjust,first_date,last_date,bar_count,updated_at) VALUES (?,?,?,?,?,?)',
    ).run(code, adjust, row.f || '', row.l || '', Number(row.n), nowStamp());
  }

  /** 读存档（升序）。limit>0 时取最近 limit 根。 */
  loadBars(code, {
    adjust = 'raw', start = '', end = '', limit = 0,
  } = {}) {
    const adj = String(adjust || 'raw').toLowerCase();
    let sql = 'SELECT date,open,close,high,low,volume_lot,amount '
      + 'FROM bars WHERE code=? AND adjust=?';
    const params = [code, adj];
    if (start) {
      sql += ' AND date>=?';
      params.push(start);
    }
    if (end) {
      sql += ' AND date<=?';
      params.push(end);
    }
    if (limit && limit > 0) {
      sql += ' ORDER BY date DESC LIMIT ?';
      params.push(Math.trunc(limit));
    } else sql += ' ORDER BY date ASC';
    let rows = this._read((db) => db.prepare(sql).all(...params));
    if (limit && limit > 0) rows = rows.reverse();
    return rows.map((r) => ({
      date: r.date,
      open: r.open,
      close: r.close,
      high: r.high,
      low: r.low,
      volume_lot: r.volume_lot,
      amount_yuan: r.amount,
    }));
  }

  loadMany(codes, { adjust = 'raw', limit = 0 } = {}) {
    const out = {};
    for (const code of codes) out[code] = this.loadBars(code, { adjust, limit });
    return out;
  }

  stats() {
    const row = this._read((db) => db.prepare(
      'SELECT COUNT(DISTINCT code) AS codes, COUNT(*) AS bars, '
      + 'MIN(date) AS f, MAX(date) AS l FROM bars',
    ).get());
    const per = this._read((db) => db.prepare(
      'SELECT code, adjust, first_date, last_date, bar_count '
      + 'FROM archive_meta ORDER BY bar_count DESC LIMIT 50',
    ).all());
    let size = 0;
    try { size = fs.statSync(this.path).size; } catch { size = 0; }
    return {
      path: this.path,
      codes: Number(row?.codes || 0),
      bars: Number(row?.bars || 0),
      first_date: row?.f || '',
      last_date: row?.l || '',
      size_bytes: size,
      size_human: humanSize(size),
      detail: per.map((r) => ({ ...r })),
    };
  }

  coverage(codes) {
    const out = {};
    this._read((db) => {
      for (const code of codes) {
        const rows = db.prepare(
          'SELECT adjust,first_date,last_date,bar_count FROM archive_meta WHERE code=?',
        ).all(code);
        if (!rows.length) {
          out[code] = { bar_count: 0, first_date: '', last_date: '' };
          continue;
        }
        const best = rows.reduce((a, b) => (Number(b.bar_count) > Number(a.bar_count) ? b : a));
        out[code] = {
          adjust: best.adjust,
          bar_count: Number(best.bar_count),
          first_date: best.first_date,
          last_date: best.last_date,
        };
      }
      return out;
    });
    return out;
  }

  prune({ before = '', codes = null } = {}) {
    if (!before && (!codes || !codes.length)) {
      throw new Error('必须指定 before 日期或 codes，否则会清空全部存档');
    }
    const conds = [];
    const params = [];
    if (before) {
      conds.push('date<?');
      params.push(before);
    }
    if (codes?.length) {
      conds.push(`code IN (${codes.map(() => '?').join(',')})`);
      params.push(...codes);
    }
    return this._db((db) => {
      const info = db.prepare(`DELETE FROM bars WHERE ${conds.join(' AND ')}`).run(...params);
      if (codes?.length) {
        for (const code of codes) {
          db.prepare('DELETE FROM archive_meta WHERE code=?').run(code);
        }
      } else if (before) {
        db.prepare('DELETE FROM archive_meta').run();
      }
      return { deleted: Number(info.changes || 0) };
    });
  }
}

/** 对一批标的做增量更新（取最近 N 根、按主键幂等覆盖）。 */
export async function updateFromProvider(archive, codes, fetchFn, adjust = 'raw', limit = 640) {
  const result = { updated: [], failed: [], total_saved: 0 };
  for (const code of codes) {
    let bars;
    try {
      bars = await fetchFn(code, adjust, limit);
    } catch (error) {
      result.failed.push({ code, error: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    if (!bars?.length) {
      result.failed.push({ code, error: '无数据返回' });
      continue;
    }
    const info = archive.saveBars(code, bars, adjust);
    result.total_saved += info.saved;
    result.updated.push({ code, ...info });
  }
  return result;
}

/** 纯列表合并：存档优先，在线补缺口。 */
export function mergedBarsDicts(archived, online) {
  const byDate = {};
  for (const b of online || []) {
    const d = String(b.date || '');
    if (d) byDate[d] = b;
  }
  for (const b of archived || []) {
    const d = String(b.date || '');
    if (d) byDate[d] = b;
  }
  return Object.keys(byDate).sort().map((d) => byDate[d]);
}
