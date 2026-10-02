import 'dotenv/config';
import { db } from '../src/config/database.js';
import { migrationOrder } from '../src/models/index.js';

if (process.env.NODE_ENV !== 'development') throw new Error('Reset is only allowed with NODE_ENV=development');
if (process.env.DB_NAME !== 'restaurant_pos') throw new Error('Reset is only allowed for restaurant_pos');

try {
  await db.authenticate();
  const expected = migrationOrder.map((model) => model.getTableName());
  const [rows] = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  const actual = new Set(rows.map((row) => row.tablename));
  const missing = expected.filter((name) => !actual.has(name));
  if (missing.length) throw new Error(`Database schema is incomplete: ${missing.join(', ')}`);

  const counts = [];
  for (const name of expected) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`Unexpected table name: ${name}`);
    const [[row]] = await db.query(`SELECT count(*)::int AS count FROM "${name}"`);
    counts.push({ table: name, rows: row.count });
  }
  console.table(counts);

  if (process.argv.includes('--execute')) {
    await db.transaction(async (transaction) => {
      await db.query(`TRUNCATE TABLE ${expected.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`, { transaction });
    });
    console.log('Development POS records cleared; database schema remains available.');
  } else {
    console.log('Preview only. Add --execute to clear these application tables.');
  }
} finally {
  await db.close();
}
