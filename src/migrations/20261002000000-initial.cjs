'use strict';
module.exports = {
  async up(queryInterface) {
    const { migrationOrder } = await import('../models/index.js');
    for (const model of migrationOrder) {
      const columns = {};
      for (const [name, attr] of Object.entries(model.rawAttributes)) {
        if (name === 'snapshot' && model.tableName === 'receipts') continue;
        columns[attr.field || name] = { ...attr };
      }
      await queryInterface.createTable(model.tableName, columns);
      for (const index of model.options.indexes || []) await queryInterface.addIndex(model.tableName, index.fields, index);
    }
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX one_active_order_per_table ON orders (table_id) WHERE table_id IS NOT NULL AND status NOT IN ('CANCELLED','CLOSED')`);
  },
  async down(queryInterface) {
    const { migrationOrder } = await import('../models/index.js');
    for (const model of [...migrationOrder].reverse()) await queryInterface.dropTable(model.tableName);
  },
};
