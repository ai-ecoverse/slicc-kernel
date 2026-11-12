import { DatabaseSync } from 'node:sqlite';

const TRANSACTION_STATEMENT = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function bound(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function workerdRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? value.slice().buffer : value;
  }
  return out;
}

export function sqlStorage(path = ':memory:', { transactions = true } = {}) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
  const statements = new Map();
  const counted = { statements: 0, rowsWritten: 0, transactions: 0, writes: 0 };
  let depth = 0;
  const sql = {
    counted,
    db,
    exec(query, ...bindings) {
      if (TRANSACTION_STATEMENT.test(query)) {
        throw new Error('SQL transaction statements are refused, use transaction()');
      }
      let statement = statements.get(query);
      if (!statement) statements.set(query, (statement = db.prepare(query)));
      const args = bindings.map(bound);
      const reads = statement.columns().length > 0;
      const rows = reads ? statement.all(...args) : [];
      const changes = reads ? 0 : Number(statement.run(...args).changes);
      const rowsWritten = reads && /\bRETURNING\b/i.test(query) ? rows.length : changes;
      counted.statements++;
      counted.rowsWritten += rowsWritten;
      if (rowsWritten > 0 && depth === 0) counted.writes++;
      const result = rows.map(workerdRow);
      return {
        rowsWritten,
        toArray: () => result,
        one: () => {
          if (result.length !== 1) throw new Error(`expected one row, got ${result.length}`);
          return result[0];
        },
      };
    },
    close() {
      db.close();
    },
  };
  if (transactions) {
    sql.transaction = (fn) => {
      if (depth === 0) counted.transactions++;
      const name = `slicc_tx_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    };
  }
  return sql;
}
