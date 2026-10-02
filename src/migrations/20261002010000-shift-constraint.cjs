'use strict';
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX one_active_shift_per_user ON shifts (user_id) WHERE ended_at IS NULL');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX one_active_shift_per_user');
  },
};
