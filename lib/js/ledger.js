/**
 * 交易台账（SQLite）——上游 `astock_ledger.py` 的 Node 移植。
 *
 * 表结构与 Python 版**完全一致**（trades / positions / cash / watchlist /
 * meta / plans），因此两条路径可以读写同一个 `ledger.sqlite`，迁移期间
 * 不会出现"Python 记的账 Node 看不见"。
 *
 * 所有方法同步（node:sqlite 是同步 API）；插件层直接调用即可。
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import {
  BOARD, BOARD_LABELS, boardOf, calcFee, checkOrderSize, feeBreakdownDict,
  feeConfig, normalizeCode, roundPrice, toFloat,
} from './market.js';

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date  TEXT NOT NULL,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    side        TEXT NOT NULL,
    price       REAL NOT NULL,
    shares      INTEGER NOT NULL,
    amount      REAL NOT NULL,
    fee         REAL NOT NULL DEFAULT 0,
    fee_detail  TEXT NOT NULL DEFAULT '',
    realized    REAL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_code ON trades(code, trade_date);

CREATE TABLE IF NOT EXISTS positions (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    shares      INTEGER NOT NULL DEFAULT 0,
    cost_price  REAL NOT NULL DEFAULT 0,
    opened_at   TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cash (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    balance     REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT ''
);

-- ── 本金（出入金）──────────────────────────────────────────────
-- 「我投进去多少钱」是交易流水算不出来的：流水能给出浮动 + 已实现，
-- 但看不见分红/利息这类非交易入账，也分不清「赚了 800」和「又打了 800 进来」。
-- 没有这张表时只能拿「总资产 − 累计盈亏」倒推本金，一有出入金/资金校准就漂，
-- 面板上的收益率会跟着一起错。有它以后：账户盈亏 = 总资产 − 净本金。
CREATE TABLE IF NOT EXISTS capital (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date  TEXT NOT NULL,
    amount      REAL NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    added_at    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS plans (
    plan_id     TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    side        TEXT NOT NULL,
    price       REAL NOT NULL DEFAULT 0,
    price_low   REAL,
    price_high  REAL,
    shares      INTEGER NOT NULL DEFAULT 0,
    stop_loss   REAL,
    take_profit REAL,
    trailing    REAL,
    reason        TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    note          TEXT NOT NULL DEFAULT '',
    -- 手动「事件单」（券商条件单）：触发条件与有效期
    trigger_kind  TEXT NOT NULL DEFAULT '',
    trigger_price REAL,
    order_type    TEXT NOT NULL DEFAULT '',
    valid_until   TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_plans_code ON plans(code, status);

-- ── 判断留痕（研究档案）────────────────────────────────────────────
-- 只记「当时我说了什么、凭什么说、什么时候来复核」，到期用**真实价格**
-- 判定兑现与否。它记的是已发生的判断，不是预测：没有概率、没有目标价。
CREATE TABLE IF NOT EXISTS theses (
    thesis_id        TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    code             TEXT NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    stance           TEXT NOT NULL DEFAULT 'watch',
    claim            TEXT NOT NULL,
    basis            TEXT NOT NULL DEFAULT '',
    -- 记录当时的数据快照（JSON）：以后回看「我凭什么这么判断」，不用靠记忆
    snapshot         TEXT NOT NULL DEFAULT '',
    price_at         REAL,
    evidence_for     TEXT NOT NULL DEFAULT '',
    evidence_against TEXT NOT NULL DEFAULT '',
    verify_date      TEXT NOT NULL DEFAULT '',
    verify_kind      TEXT NOT NULL DEFAULT '',
    verify_price     REAL,
    outcome          TEXT NOT NULL DEFAULT 'pending',
    outcome_price    REAL,
    outcome_note     TEXT NOT NULL DEFAULT '',
    outcome_at       TEXT NOT NULL DEFAULT '',
    version          INTEGER NOT NULL DEFAULT 1,
    prev_id          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_theses_code ON theses(code, created_at);
CREATE INDEX IF NOT EXISTS idx_theses_due ON theses(outcome, verify_date);
`;

/** 判断的方向：看多/看空/只观察。刻意不给「强烈推荐」这类无法证伪的档位。 */
export const THESIS_STANCES = ['bull', 'bear', 'watch'];
/** 判断的复核结果：未到期 / 兑现 / 未兑现 / 已作废（条件变了，判断不再适用）。 */
export const THESIS_OUTCOMES = ['pending', 'hit', 'miss', 'void'];
/** 可复算的复核条件；留空则到期人工判定。 */
export const THESIS_VERIFY_KINDS = ['', 'price_below', 'price_above'];

export class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 与 `today()` 同值，但**名字不同**。
 *
 * 参数默认值里不能写 `today = today()`：默认值表达式解析的是**参数自身**的
 * 绑定，那一刻还没初始化，会抛 `ReferenceError: Cannot access 'today' before
 * initialization`。之前所有调用方都显式传了 today，所以一直没暴露，
 * 直到面板不传才踩到。
 */
function currentDate() {
  return today();
}

function nowStamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function round4(v) {
  return Math.round((Number(v) + Number.EPSILON) * 1e4) / 1e4;
}

function jsonDumps(obj) {
  return JSON.stringify(obj);
}

function jsonLoads(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export class Ledger {
  /**
   * @param {string} dbPath
   * @param {object} [fee] FeeConfig
   */
  constructor(dbPath, fee) {
    this.path = path.resolve(String(dbPath));
    this.fee = feeConfig(fee || {});
    this._initDb();
  }

  refreshFee(fee) {
    this.fee = feeConfig(fee || {});
  }

  // -------------------------------------------------- 基础设施

  _connect() {
    fs.mkdirSync(path.dirname(this.path) || '.', { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA busy_timeout=10000');
    return db;
  }

  /** 打开 → 执行 → 保证 close（异常也 close）。 */
  _db(fn) {
    const db = this._connect();
    try {
      db.exec('BEGIN');
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 忽略回滚失败
      }
      throw error;
    } finally {
      try {
        db.close();
      } catch {
        // 忽略关闭失败
      }
    }
  }

  /** 只读查询（不开显式事务，减少 WAL 写锁）。 */
  _read(fn) {
    const db = this._connect();
    try {
      return fn(db);
    } finally {
      try {
        db.close();
      } catch {
        // 忽略关闭失败
      }
    }
  }

  _initDb() {
    const db = this._connect();
    try {
      db.exec(SQL_SCHEMA);
      // 老库补列：SQLite 的 CREATE TABLE IF NOT EXISTS 不会加新列，必须显式迁移
      const columns = new Set(
        db.prepare('PRAGMA table_info(plans)').all().map((row) => String(row.name)),
      );
      for (const [name, decl] of [
        ['trigger_kind', "TEXT NOT NULL DEFAULT ''"],
        ['trigger_price', 'REAL'],
        ['order_type', "TEXT NOT NULL DEFAULT ''"],
        ['valid_until', "TEXT NOT NULL DEFAULT ''"],
        ['source', "TEXT NOT NULL DEFAULT ''"],
      ]) {
        if (!columns.has(name)) db.exec(`ALTER TABLE plans ADD COLUMN ${name} ${decl}`);
      }
      db.prepare(
        'INSERT OR IGNORE INTO cash(id, balance, updated_at) VALUES (1, 0, ?)',
      ).run(nowStamp());
    } finally {
      db.close();
    }
  }

  // -------------------------------------------------- 资金

  getCash() {
    const row = this._read((db) => db.prepare(
      'SELECT balance, updated_at FROM cash WHERE id=1',
    ).get());
    return {
      balance: row ? round2(row.balance) : 0.0,
      updated_at: row ? String(row.updated_at || '') : '',
    };
  }

  setCash(balance) {
    if (Number(balance) < 0) throw new LedgerError('资金余额不能为负数');
    this._db((db) => {
      db.prepare('UPDATE cash SET balance=?, updated_at=? WHERE id=1')
        .run(round2(balance), nowStamp());
    });
    return this.getCash();
  }

  addCash(delta) {
    return this.setCash(this.getCash().balance + Number(delta));
  }

  // -------------------------------------------------- 本金（出入金）

  /**
   * 记一笔出入金：正数＝入金、负数＝出金。
   *
   * 本金是「账户盈亏」的唯一锚点：`总资产 − 净本金` 才是用户理解的
   * 「我投了 2 万，现在亏了 300」。交易流水只能给出浮动 + 已实现，
   * 两个口径对不上时差额要显式列出来，不能互相顶替。
   */
  addCapital(amount, { date = '', note = '' } = {}) {
    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value === 0) {
      throw new LedgerError('出入金金额必须是非 0 数字（入金填正数、出金填负数）');
    }
    const raw = String(date || '').trim();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today();
    const out = this._db((db) => {
      const info = db.prepare(
        'INSERT INTO capital(entry_date, amount, note, created_at) VALUES (?,?,?,?)',
      ).run(day, value, String(note || ''), nowStamp());
      return db.prepare('SELECT id, entry_date, amount, note FROM capital WHERE id=?')
        .get(Number(info.lastInsertRowid));
    });
    return {
      id: Number(out.id),
      date: String(out.entry_date || ''),
      amount: round2(out.amount),
      note: String(out.note || ''),
    };
  }

  listCapital(limit = 50) {
    const rows = this._read((db) => db.prepare(
      'SELECT id, entry_date, amount, note, created_at FROM capital '
      + 'ORDER BY entry_date DESC, id DESC LIMIT ?',
    ).all(Math.max(1, Math.min(Number(limit) || 50, 500))));
    return rows.map((row) => ({
      id: Number(row.id),
      date: String(row.entry_date || ''),
      amount: round2(row.amount),
      note: String(row.note || ''),
      created_at: String(row.created_at || ''),
    }));
  }

  /**
   * 净本金（入金 − 出金）。
   *
   * `count === 0` 表示**还没登记过**，调用方必须按「未知」处理（不能用 0
   * 当本金，否则收益率会变成除以 0 或无穷大）。
   */
  netCapital() {
    const row = this._read((db) => db.prepare(
      'SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n, MIN(entry_date) AS first_date FROM capital',
    ).get());
    return {
      total: round2(Number(row?.total || 0)),
      count: Number(row?.n || 0),
      first_date: String(row?.first_date || ''),
    };
  }

  deleteCapital(id) {
    const key = Number(id);
    if (!Number.isFinite(key)) throw new LedgerError('capital id 无效');
    const removed = this._db((db) => {
      const row = db.prepare('SELECT id, entry_date, amount FROM capital WHERE id=?').get(key);
      if (!row) return null;
      db.prepare('DELETE FROM capital WHERE id=?').run(key);
      return row;
    });
    if (!removed) throw new LedgerError(`没有 id=${key} 的出入金记录`);
    return { id: key, date: String(removed.entry_date || ''), amount: round2(removed.amount) };
  }

  // -------------------------------------------------- 自选股

  addWatch(rawCode, name = '', note = '') {
    const { code } = normalizeCode(rawCode);
    this._db((db) => {
      db.prepare(
        'INSERT INTO watchlist(code, name, note, added_at) VALUES (?,?,?,?) '
        + 'ON CONFLICT(code) DO UPDATE SET name=excluded.name, note=excluded.note',
      ).run(code, String(name || ''), String(note || ''), nowStamp());
    });
    return { code, name: String(name || ''), note: String(note || '') };
  }

  removeWatch(rawCode) {
    const { code } = normalizeCode(rawCode);
    const info = this._db((db) => db.prepare('DELETE FROM watchlist WHERE code=?').run(code));
    return Number(info.changes || 0) > 0;
  }

  listWatch() {
    return this._read((db) => db.prepare(
      'SELECT code, name, note, added_at FROM watchlist ORDER BY added_at',
    ).all()).map((row) => ({ ...row }));
  }

  // -------------------------------------------------- 持仓

  _position(db, code) {
    return db.prepare('SELECT * FROM positions WHERE code=?').get(code);
  }

  listPositions() {
    return this._read((db) => {
      const rows = db.prepare(
        'SELECT code, name, shares, cost_price, opened_at, updated_at, note '
        + 'FROM positions WHERE shares > 0 ORDER BY code',
      ).all();
      return rows.map((row) => {
        const d = { ...row };
        d.board = BOARD_LABELS[boardOf(d.code)] || '';
        d.cost_amount = round2(Number(d.shares) * Number(d.cost_price));
        d.available_today = this._available(db, d.code, Number(d.shares));
        return d;
      });
    });
  }

  /** T+1 可用股数 = 总持仓 - 今日净买入。 */
  _available(db, code, total) {
    const day = today();
    const row = db.prepare(
      "SELECT COALESCE(SUM(CASE WHEN side='buy' THEN shares ELSE 0 END),0) AS b, "
      + "       COALESCE(SUM(CASE WHEN side='sell' THEN shares ELSE 0 END),0) AS s "
      + 'FROM trades WHERE code=? AND trade_date=?',
    ).get(code, day);
    const bought = Number(row?.b || 0);
    const sold = Number(row?.s || 0);
    let held = total;
    if (held === undefined || held === null) {
      const pos = this._position(db, code);
      held = pos ? Number(pos.shares) : 0;
    }
    const locked = Math.max(0, bought - sold);
    return Math.max(0, Number(held) - locked);
  }

  // -------------------------------------------------- 录入成交

  recordTrade(rawCode, side, price, shares, {
    tradeDate = '', name = '', note = '', feeOverride = null,
  } = {}) {
    const dir = String(side || '').trim().toLowerCase();
    if (!['buy', 'sell'].includes(dir)) throw new LedgerError('side 只能是 buy 或 sell');
    const { code } = normalizeCode(rawCode);
    const px = roundPrice(toFloat(price, 0) || 0);
    if (px <= 0) throw new LedgerError('成交价格必须大于 0');
    const qty = Math.trunc(Number(shares) || 0);
    const day = String(tradeDate || '').trim() || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      throw new LedgerError(`成交日期格式应为 YYYY-MM-DD，收到 ${JSON.stringify(tradeDate)}`);
    }
    if (day > today()) throw new LedgerError('成交日期不能晚于今天（未来日期会让 T+1 判断失真）');

    const amount = round2(px * qty);
    const board = boardOf(code);
    const feeBd = calcFee(amount, dir, this.fee, board);
    const fee = feeOverride === null || feeOverride === undefined
      ? round2(feeBd.total) : round2(feeOverride);

    const out = this._db((db) => {
      const pos = this._position(db, code);
      const curShares = pos ? Number(pos.shares) : 0;
      const curCost = pos ? Number(pos.cost_price) : 0.0;
      const curName = (pos ? String(pos.name || '') : '') || String(name || '');
      let newShares;
      let newCost;
      let realized = null;

      if (dir === 'buy') {
        const err = checkOrderSize(qty, code, 'buy', curShares);
        if (err) throw new LedgerError(err);
        newShares = curShares + qty;
        const totalCost = curCost * curShares + amount + fee;
        newCost = newShares ? round4(totalCost / newShares) : 0.0;
      } else {
        if (curShares <= 0) throw new LedgerError(`${code} 当前无持仓，无法录入卖出`);
        const available = this._available(db, code, curShares);
        if (qty > available) {
          const locked = curShares - available;
          const hint = locked > 0 ? `（另有 ${locked} 股为今日买入，T+1 明日才可卖）` : '';
          throw new LedgerError(
            `可卖数量不足：${code} 持仓 ${curShares} 股，今日可卖 ${available} 股，`
            + `本次想卖 ${qty} 股${hint}`,
          );
        }
        const err = checkOrderSize(qty, code, 'sell', curShares);
        if (err) throw new LedgerError(err);
        newShares = curShares - qty;
        realized = round2((px - curCost) * qty - fee);
        newCost = newShares ? round4(curCost) : 0.0;
      }

      db.prepare(
        'INSERT INTO trades(trade_date, code, name, side, price, shares, amount,'
        + ' fee, fee_detail, realized, note, created_at) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(day, code, curName || String(name || ''), dir, px, qty, amount,
        fee, jsonDumps(feeBreakdownDict(feeBd)), realized, String(note || ''), nowStamp());

      if (newShares > 0) {
        db.prepare(
          'INSERT INTO positions(code, name, shares, cost_price, opened_at,'
          + ' updated_at, note) VALUES (?,?,?,?,?,?,?) '
          + 'ON CONFLICT(code) DO UPDATE SET name=excluded.name,'
          + ' shares=excluded.shares, cost_price=excluded.cost_price,'
          + ' updated_at=excluded.updated_at',
        ).run(code, curName || String(name || ''), newShares, newCost,
          pos ? String(pos.opened_at || '') : day, nowStamp(),
          pos ? String(pos.note || '') : '');
      } else {
        db.prepare('DELETE FROM positions WHERE code=?').run(code);
      }

      if (realized !== null) {
        const row = db.prepare("SELECT value FROM meta WHERE key='realized_pnl'").get();
        let prev = 0;
        try {
          prev = row ? Number(row.value) || 0 : 0;
        } catch {
          prev = 0;
        }
        const total = round2(prev + realized);
        db.prepare(
          "INSERT INTO meta(key, value) VALUES('realized_pnl', ?) "
          + 'ON CONFLICT(key) DO UPDATE SET value=?',
        ).run(String(total), String(total));
      }

      return {
        code,
        name: curName || String(name || ''),
        side: dir,
        price: px,
        shares: qty,
        amount,
        trade_date: day,
        fee,
        fee_detail: feeBreakdownDict(feeBd),
        cost_price_before: curShares ? round4(curCost) : null,
        cost_price_after: newCost,
        shares_after: newShares,
        realized_pnl: realized,
        cash_delta: round2(dir === 'buy' ? -(amount + fee) : amount - fee),
      };
    });
    return out;
  }

  // -------------------------------------------------- 查询

  trades({ code = '', limit = 50, offset = 0, start = '', end = '' } = {}) {
    let sql = 'SELECT id, trade_date, code, name, side, price, shares, amount, fee,'
      + ' realized, note, created_at FROM trades WHERE 1=1';
    const params = [];
    if (code) {
      params.push(normalizeCode(code).code);
      sql += ' AND code=?';
    }
    if (start) {
      sql += ' AND trade_date>=?';
      params.push(start);
    }
    if (end) {
      sql += ' AND trade_date<=?';
      params.push(end);
    }
    sql += ' ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?';
    params.push(Math.max(1, Math.min(Number(limit) || 50, 500)));
    params.push(Math.max(0, Math.trunc(Number(offset) || 0)));
    const rows = this._read((db) => db.prepare(sql).all(...params));
    return rows.map((row) => {
      const d = { ...row };
      d.fee_detail = jsonLoads(d.fee_detail, {});
      return d;
    });
  }

  /** 与 {@link trades} 同条件的总条数（分页用）。 */
  countTrades({ code = '', start = '', end = '' } = {}) {
    let sql = 'SELECT COUNT(*) AS n FROM trades WHERE 1=1';
    const params = [];
    if (code) {
      params.push(normalizeCode(code).code);
      sql += ' AND code=?';
    }
    if (start) {
      sql += ' AND trade_date>=?';
      params.push(start);
    }
    if (end) {
      sql += ' AND trade_date<=?';
      params.push(end);
    }
    const row = this._read((db) => db.prepare(sql).get(...params));
    return Number(row?.n || 0);
  }

  realizedPnl({ start = '', end = '' } = {}) {
    let sql = 'SELECT COALESCE(SUM(realized),0) AS total, COUNT(*) AS n FROM trades '
      + 'WHERE realized IS NOT NULL';
    const params = [];
    if (start) {
      sql += ' AND trade_date>=?';
      params.push(start);
    }
    if (end) {
      sql += ' AND trade_date<=?';
      params.push(end);
    }
    const row = this._read((db) => db.prepare(sql).get(...params));
    return {
      realized_pnl: round2(Number(row?.total || 0)),
      sell_count: Number(row?.n || 0),
    };
  }

  totalFee({ start = '', end = '' } = {}) {
    let sql = 'SELECT COALESCE(SUM(fee),0) AS total FROM trades WHERE 1=1';
    const params = [];
    if (start) {
      sql += ' AND trade_date>=?';
      params.push(start);
    }
    if (end) {
      sql += ' AND trade_date<=?';
      params.push(end);
    }
    const row = this._read((db) => db.prepare(sql).get(...params));
    return round2(Number(row?.total || 0));
  }

  // -------------------------------------------------- 建议计划

  nextPlanId() {
    const d = new Date();
    const prefix = `P${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`;
    const row = this._read((db) => db.prepare(
      'SELECT COUNT(*) AS n FROM plans WHERE plan_id LIKE ?',
    ).get(`${prefix}%`));
    return prefix + String(Number(row?.n || 0) + 1);
  }

  savePlan(plan = {}) {
    const { code } = normalizeCode(String(plan.code || ''));
    const side = String(plan.side || 'buy').toLowerCase();
    if (!['buy', 'sell'].includes(side)) throw new LedgerError('计划方向只能是 buy / sell');
    const planId = String(plan.plan_id || '').trim() || this.nextPlanId();
    this._db((db) => {
      db.prepare(
        'INSERT INTO plans(plan_id, created_at, code, name, side, price,'
        + ' price_low, price_high, shares, stop_loss, take_profit, trailing,'
        + ' reason, kind, status, note, trigger_kind, trigger_price, order_type,'
        + ' valid_until, source) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '
        + 'ON CONFLICT(plan_id) DO UPDATE SET price=excluded.price,'
        + ' shares=excluded.shares, stop_loss=excluded.stop_loss,'
        + ' take_profit=excluded.take_profit, trailing=excluded.trailing,'
        + ' status=excluded.status, note=excluded.note,'
        + ' trigger_kind=excluded.trigger_kind, trigger_price=excluded.trigger_price,'
        + ' order_type=excluded.order_type, valid_until=excluded.valid_until,'
        + ' source=excluded.source',
      ).run(planId, nowStamp(), code, String(plan.name || ''), side,
        Number(plan.price || 0), plan.price_low ?? null, plan.price_high ?? null,
        Math.trunc(Number(plan.shares || 0)), plan.stop_loss ?? null,
        plan.take_profit ?? null, plan.trailing ?? null,
        String(plan.reason || ''), String(plan.kind || ''),
        String(plan.status || 'pending'), String(plan.note || ''),
        String(plan.trigger_kind || ''), plan.trigger_price ?? null,
        String(plan.order_type || ''), String(plan.valid_until || ''),
        String(plan.source || ''));
    });
    return this.getPlan(planId) || { plan_id: planId };
  }

  getPlan(planId) {
    const row = this._read((db) => db.prepare('SELECT * FROM plans WHERE plan_id=?')
      .get(String(planId)));
    return row ? { ...row } : null;
  }

  listPlans({ status = '', limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM plans';
    const params = [];
    if (status) {
      sql += ' WHERE status=?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC, plan_id DESC LIMIT ? OFFSET ?';
    params.push(Math.max(1, Math.min(Number(limit) || 50, 300)));
    params.push(Math.max(0, Math.trunc(Number(offset) || 0)));
    return this._read((db) => db.prepare(sql).all(...params)).map((row) => ({ ...row }));
  }

  /** 与 {@link listPlans} 同条件的总条数（分页用）。 */
  countPlans({ status = '' } = {}) {
    let sql = 'SELECT COUNT(*) AS n FROM plans';
    const params = [];
    if (status) {
      sql += ' WHERE status=?';
      params.push(status);
    }
    const row = this._read((db) => db.prepare(sql).get(...params));
    return Number(row?.n || 0);
  }

  matchPlan(rawCode, side, keepDays = 10) {
    const { code } = normalizeCode(rawCode);
    const cutoff = new Date(Date.now() - Math.max(1, keepDays) * 86400000);
    const cutoffText = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}`
      + `-${pad(cutoff.getDate())} 00:00:00`;
    const row = this._read((db) => db.prepare(
      "SELECT * FROM plans WHERE code=? AND side=? AND status='pending'"
      + ' AND created_at>=? ORDER BY created_at DESC, plan_id DESC LIMIT 1',
    ).get(code, String(side).toLowerCase(), cutoffText));
    return row ? { ...row } : null;
  }

  markPlan(planId, status, note = '') {
    const next = String(status || '').trim().toLowerCase();
    if (!['pending', 'filled', 'cancelled', 'expired'].includes(next)) {
      throw new LedgerError(`未知计划状态 ${JSON.stringify(status)}`);
    }
    this._db((db) => {
      db.prepare('UPDATE plans SET status=?, note=? WHERE plan_id=?')
        .run(next, String(note || ''), String(planId));
    });
    return this.getPlan(planId) || {};
  }

  // -------------------------------------------------- 判断留痕

  nextThesisId() {
    const d = new Date();
    const prefix = `T${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`;
    const row = this._read((db) => db.prepare(
      'SELECT COUNT(*) AS n FROM theses WHERE thesis_id LIKE ?',
    ).get(`${prefix}%`));
    return prefix + String(Number(row?.n || 0) + 1).padStart(2, '0');
  }

  /**
   * 记一条判断（或它的新版本）。
   *
   * 刻意**不做「预测校验」**：这里既没有目标价也没有概率，只有
   * 「我当时怎么判断 + 依据 + 什么时候来复核」。兑现与否由到期时的真实价格判定。
   */
  saveThesis(thesis = {}) {
    const claim = String(thesis.claim || '').trim();
    if (!claim) throw new LedgerError('判断内容（claim）不能为空——这里要记的是你当时怎么想的');
    const stance = String(thesis.stance || 'watch').trim().toLowerCase();
    if (!THESIS_STANCES.includes(stance)) {
      throw new LedgerError(`方向只能是 ${THESIS_STANCES.join(' / ')}（看多/看空/只观察）`);
    }
    const verifyKind = String(thesis.verify_kind || '').trim().toLowerCase();
    if (!THESIS_VERIFY_KINDS.includes(verifyKind)) {
      throw new LedgerError('复核条件类型只能是 price_below（跌破）、price_above（站上）或留空');
    }
    if (verifyKind && !Number.isFinite(Number(thesis.verify_price))) {
      throw new LedgerError('给了复核条件类型就必须给 verify_price（具体价位）');
    }
    const verifyDate = String(thesis.verify_date || '').trim();
    if (verifyDate && !/^\d{4}-\d{2}-\d{2}$/.test(verifyDate)) {
      throw new LedgerError('复核日期格式应为 YYYY-MM-DD');
    }

    const rawCode = String(thesis.code || '').trim();
    const { code } = rawCode ? normalizeCode(rawCode) : { code: '' };

    // 版本：显式给了 prev_id 就在它上面叠一版，否则是新判断
    const prevId = String(thesis.prev_id || '').trim();
    const prev = prevId ? this.getThesis(prevId) : null;
    const thesisId = String(thesis.thesis_id || '').trim() || this.nextThesisId();
    const version = prev ? Number(prev.version || 1) + 1 : 1;
    const stamp = nowStamp();

    this._db((db) => {
      db.prepare(
        'INSERT INTO theses(thesis_id, created_at, updated_at, code, name, stance,'
        + ' claim, basis, snapshot, price_at, evidence_for, evidence_against,'
        + ' verify_date, verify_kind, verify_price, outcome, outcome_price,'
        + ' outcome_note, outcome_at, version, prev_id) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        thesisId, stamp, stamp, code, String(thesis.name || ''), stance,
        claim, String(thesis.basis || ''),
        typeof thesis.snapshot === 'string' ? thesis.snapshot : JSON.stringify(thesis.snapshot || {}),
        thesis.price_at === null || thesis.price_at === undefined ? null : Number(thesis.price_at),
        String(thesis.evidence_for || ''), String(thesis.evidence_against || ''),
        verifyDate, verifyKind,
        verifyKind ? Number(thesis.verify_price) : null,
        'pending', null, '', '', version, prevId,
      );
    });
    return this.getThesis(thesisId) || { thesis_id: thesisId };
  }

  getThesis(thesisId) {
    const row = this._read((db) => db.prepare('SELECT * FROM theses WHERE thesis_id=?')
      .get(String(thesisId)));
    return row ? { ...row } : null;
  }

  /**
   * 列判断。
   *
   * @param {object} [query]
   * @param {string} [query.code]     只看某只
   * @param {string} [query.outcome]  pending / hit / miss / void
   * @param {boolean} [query.due]     true＝只要「已到复核日且还没判定」的
   * @param {string} [query.today]    due 用的今天日期（YYYY-MM-DD，便于测试注入）
   */
  listTheses({
    code = '', outcome = '', due = false, today: todayText = currentDate(), limit = 50, offset = 0,
  } = {}) {
    const where = [];
    const params = [];
    if (code) {
      where.push('code=?');
      params.push(normalizeCode(String(code)).code);
    }
    if (outcome) {
      where.push('outcome=?');
      params.push(String(outcome));
    }
    if (due) {
      // 到期＝复核日已到或已过，且还没判定
      where.push("outcome='pending' AND verify_date<>'' AND verify_date<=?");
      params.push(String(todayText));
    }
    const sql = 'SELECT * FROM theses'
      + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY verify_date DESC, created_at DESC, thesis_id DESC LIMIT ? OFFSET ?';
    params.push(Math.max(1, Math.min(Number(limit) || 50, 300)));
    params.push(Math.max(0, Math.trunc(Number(offset) || 0)));
    return this._read((db) => db.prepare(sql).all(...params)).map((row) => ({ ...row }));
  }

  countTheses({ code = '', outcome = '', due = false, today: todayText = currentDate() } = {}) {
    const where = [];
    const params = [];
    if (code) {
      where.push('code=?');
      params.push(normalizeCode(String(code)).code);
    }
    if (outcome) {
      where.push('outcome=?');
      params.push(String(outcome));
    }
    if (due) {
      where.push("outcome='pending' AND verify_date<>'' AND verify_date<=?");
      params.push(String(todayText));
    }
    const row = this._read((db) => db.prepare(
      'SELECT COUNT(*) AS n FROM theses' + (where.length ? ` WHERE ${where.join(' AND ')}` : ''),
    ).get(...params));
    return Number(row?.n || 0);
  }

  /** 一整条判断的所有版本（按 version 升序）。 */
  thesisVersions(rawCode) {
    const { code } = normalizeCode(String(rawCode || ''));
    return this._read((db) => db.prepare(
      'SELECT * FROM theses WHERE code=? ORDER BY version ASC, created_at ASC',
    ).all(code)).map((row) => ({ ...row }));
  }

  /**
   * 审定结果。outcome 只接受 hit / miss / void——pending 是初始态，不能手动「审回未决」。
   *
   * @param {string} thesisId
   * @param {{outcome: string, price?: number, note?: string}} verdict
   */
  settleThesis(thesisId, verdict = {}) {
    const outcome = String(verdict.outcome || '').trim().toLowerCase();
    if (!['hit', 'miss', 'void'].includes(outcome)) {
      throw new LedgerError('复核结果只能是 hit（兑现）/ miss（未兑现）/ void（作废）');
    }
    const current = this.getThesis(thesisId);
    if (!current) throw new LedgerError(`没有这条判断：${thesisId}`);
    if (String(current.outcome) !== 'pending') {
      throw new LedgerError(`这条判断已审定为「${current.outcome}」，不能重复判定`
        + '（条件变了请用 prev_id 记一个新版本）');
    }
    const price = verdict.price === null || verdict.price === undefined
      ? null : Number(verdict.price);
    this._db((db) => {
      db.prepare('UPDATE theses SET outcome=?, outcome_price=?, outcome_note=?,'
        + ' outcome_at=?, updated_at=? WHERE thesis_id=?')
        .run(outcome, price, String(verdict.note || ''), nowStamp(), nowStamp(),
          String(thesisId));
    });
    return this.getThesis(thesisId) || {};
  }

  /** 兑现统计（按全库或单只）。分母只算已判定的 hit+miss，void 与 pending 单列。 */
  thesisStats({ code = '' } = {}) {
    const where = code ? ' WHERE code=?' : '';
    const params = code ? [normalizeCode(String(code)).code] : [];
    const rows = this._read((db) => db.prepare(
      `SELECT outcome, COUNT(*) AS n FROM theses${where} GROUP BY outcome`,
    ).all(...params));
    const counts = { pending: 0, hit: 0, miss: 0, void: 0 };
    for (const row of rows) {
      const key = String(row.outcome || 'pending');
      if (key in counts) counts[key] += Number(row.n || 0);
    }
    const settled = counts.hit + counts.miss;
    return {
      ...counts,
      settled,
      total: settled + counts.pending + counts.void,
      // 注意措辞：这是「过去判断的兑现率」，不是未来上涨概率
      hit_rate: settled ? round4((counts.hit / settled) * 100) : null,
    };
  }

  exportRows() {
    return this._read((db) => ({
      positions: db.prepare('SELECT * FROM positions ORDER BY code').all().map((r) => ({ ...r })),
      trades: db.prepare('SELECT * FROM trades ORDER BY trade_date, id').all().map((r) => ({ ...r })),
      watchlist: db.prepare('SELECT * FROM watchlist ORDER BY code').all().map((r) => ({ ...r })),
      cash: db.prepare('SELECT * FROM cash').all().map((r) => ({ ...r })),
      // 本金也要跟着备份走：换机器后没有出入金记录，收益率会退回倒推口径
      capital: db.prepare('SELECT * FROM capital ORDER BY entry_date, id').all()
        .map((r) => ({ ...r })),
    }));
  }

  deleteTrade(tradeId, rebuild = true) {
    const id = Math.trunc(Number(tradeId));
    const row = this._read((db) => db.prepare('SELECT id, code FROM trades WHERE id=?').get(id));
    if (!row) throw new LedgerError(`流水 ${tradeId} 不存在`);
    const code = String(row.code);
    this._db((db) => {
      db.prepare('DELETE FROM trades WHERE id=?').run(id);
    });
    const result = { deleted: id, code };
    if (rebuild) Object.assign(result, this.rebuildPosition(code));
    return result;
  }

  rebuildPosition(rawCode) {
    const { code } = normalizeCode(rawCode);
    const rows = this.trades({ code, limit: 500 }).reverse();
    let shares = 0;
    let cost = 0.0;
    let name = '';
    let opened = '';
    for (const t of rows) {
      if (t.name) name = String(t.name);
      if (t.side === 'buy') {
        if (!opened) opened = String(t.trade_date);
        const total = cost * shares + Number(t.amount) + Number(t.fee);
        shares += Number(t.shares);
        cost = shares ? round4(total / shares) : 0.0;
      } else {
        shares -= Number(t.shares);
        if (shares <= 0) {
          shares = 0;
          cost = 0.0;
          opened = '';
        }
      }
    }
    this._db((db) => {
      if (shares > 0) {
        db.prepare(
          'INSERT INTO positions(code, name, shares, cost_price, opened_at,'
          + ' updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET'
          + ' name=excluded.name, shares=excluded.shares,'
          + ' cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        ).run(code, name, shares, cost, opened, nowStamp());
      } else {
        db.prepare('DELETE FROM positions WHERE code=?').run(code);
      }
    });
    return {
      code, shares, cost_price: round4(cost), name,
    };
  }

  /** 台账里的全部标的代码（持仓在前，自选在后，去重）。 */
  ledgerCodes() {
    const codes = this.listPositions().map((p) => p.code);
    for (const item of this.listWatch()) {
      if (!codes.includes(item.code)) codes.push(item.code);
    }
    return codes;
  }
}

/** 默认台账路径（与 config 的默认值一致，调用方通常显式传入）。 */
export function defaultLedgerPath(dataDir) {
  return path.join(dataDir, 'ledger.sqlite');
}

export { BOARD };
