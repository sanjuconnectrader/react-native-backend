'use strict';

module.exports = {
  async up(queryInterface) {
    const [roles] = await queryInterface.sequelize.query(
      "SELECT rolname FROM pg_roles WHERE rolname = 'service_role'"
    );
    if (!roles.length) return;
    const { migrationOrder } = await import('../models/index.js');
    for (const tableName of [...migrationOrder.map((model) => model.tableName), 'SequelizeMeta']) {
      await queryInterface.sequelize.query(
        `REVOKE ALL ON TABLE public.${queryInterface.quoteIdentifier(tableName)} FROM service_role`
      );
    }
  },
  async down() {},
};
