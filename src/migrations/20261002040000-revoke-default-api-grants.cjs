'use strict';

module.exports = {
  async up(queryInterface) {
    const [roles] = await queryInterface.sequelize.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')"
    );
    if (!roles.length) return; // Local PostgreSQL without Supabase API roles.
    const apiRoles = roles.map((row) => queryInterface.quoteIdentifier(row.rolname)).join(', ');
    await queryInterface.sequelize.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${apiRoles}
    `);
    await queryInterface.sequelize.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM ${apiRoles}
    `);
    await queryInterface.sequelize.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM ${apiRoles}
    `);
    await queryInterface.sequelize.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC
    `);
  },
  async down() {},
};
