import { db } from '../src/config/database.js';
import { migrationOrder } from '../src/models/index.js';

try {
  await db.authenticate();
  const names = [...migrationOrder.map((model) => model.tableName), 'SequelizeMeta'];
  const [tables] = await db.query(`
    SELECT c.relname, c.relrowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS anon_access,
      has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS authenticated_access,
      has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS service_access
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($names)
  `, { bind: { names } });
  if (tables.length !== names.length || tables.some((table) => !table.relrowsecurity || table.anon_access || table.authenticated_access || table.service_access)) {
    throw new Error('POS table missing or exposed to a Data API role');
  }
  const [defaults] = await db.query(`
    SELECT count(*)::integer AS grants FROM pg_default_acl d
    JOIN pg_roles owner ON owner.oid = d.defaclrole
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    JOIN pg_roles recipient ON recipient.oid = acl.grantee
    WHERE owner.rolname = 'postgres' AND n.nspname = 'public' AND d.defaclobjtype = 'r'
      AND recipient.rolname IN ('anon', 'authenticated', 'service_role')
      AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  `);
  if (defaults[0].grants) throw new Error('New public tables still receive Data API grants');
  const [columns] = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receipts'
  `);
  if (!columns.some((column) => column.column_name === 'snapshot_compressed') || columns.some((column) => column.column_name === 'snapshot')) {
    throw new Error('Receipt compression schema is incomplete');
  }
  const [size] = await db.query('SELECT pg_database_size(current_database()) AS bytes');
  console.log(`Verified ${tables.length} protected tables; receipts use compressed bytea.`);
  console.log(`Database size: ${(Number(size[0].bytes) / 1024 / 1024).toFixed(1)} MiB`);
} finally {
  await db.close();
}
