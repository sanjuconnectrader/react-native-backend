'use strict';

const tables = ['categories', 'menu_items', 'dining_tables'];

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of tables) {
      const columns = await queryInterface.describeTable(table);
      if (!columns.deleted_at) await queryInterface.addColumn(table, 'deleted_at', { type: Sequelize.DATE, allowNull: true });
    }

    const indexes = await queryInterface.showIndex('dining_tables');
    if (!indexes.some((index) => index.name === 'dining_tables_restaurant_id_table_number_active')) {
      await queryInterface.addIndex('dining_tables', ['restaurant_id', 'table_number'], {
        name: 'dining_tables_restaurant_id_table_number_active',
        unique: true,
        where: { deleted_at: null },
      });
    }
    for (const index of indexes) {
      if (index.name !== 'dining_tables_restaurant_id_table_number_active'
        && index.unique
        && index.fields.map((field) => field.attribute).join(',') === 'restaurant_id,table_number') {
        await queryInterface.removeIndex('dining_tables', index.name);
      }
    }
  },
  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('dining_tables');
    if (indexes.some((index) => index.name === 'dining_tables_restaurant_id_table_number_active')) await queryInterface.removeIndex('dining_tables', 'dining_tables_restaurant_id_table_number_active');
    await queryInterface.addIndex('dining_tables', ['restaurant_id', 'table_number'], { unique: true });
    for (const table of [...tables].reverse()) {
      const columns = await queryInterface.describeTable(table);
      if (columns.deleted_at) await queryInterface.removeColumn(table, 'deleted_at');
    }
  },
};
