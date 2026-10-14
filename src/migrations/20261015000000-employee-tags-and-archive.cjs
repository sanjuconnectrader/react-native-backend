'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('employees');
    if (!columns.tags) await queryInterface.addColumn('employees', 'tags', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    if (!columns.deleted_at) await queryInterface.addColumn('employees', 'deleted_at', { type: Sequelize.DATE, allowNull: true });
  },
  async down(queryInterface) {
    const columns = await queryInterface.describeTable('employees');
    if (columns.deleted_at) await queryInterface.removeColumn('employees', 'deleted_at');
    if (columns.tags) await queryInterface.removeColumn('employees', 'tags');
  },
};
