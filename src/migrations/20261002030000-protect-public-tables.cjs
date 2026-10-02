'use strict';

module.exports = {
  async up(queryInterface) {
    const { migrationOrder } = await import('../models/index.js');
    const [roles] = await queryInterface.sequelize.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')"
    );
    const apiRoles = roles.map((row) => row.rolname);
    for (const tableName of [...migrationOrder.map((model) => model.tableName), 'SequelizeMeta']) {
      const name = queryInterface.quoteIdentifier(tableName);
      await queryInterface.sequelize.query(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`);
      if (apiRoles.length) {
        await queryInterface.sequelize.query(
          `REVOKE ALL ON TABLE public.${name} FROM ${apiRoles.map((role) => queryInterface.quoteIdentifier(role)).join(', ')}`
        );
      }
    }
  },
  // Keep the database private when rolling back unrelated schema changes.
  async down() {},
};
