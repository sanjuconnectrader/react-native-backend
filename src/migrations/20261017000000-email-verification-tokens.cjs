'use strict';
module.exports = {
  async up(queryInterface) {
    const { EmailVerificationToken } = await import('../models/index.js');
    const columns = {};
    for (const [name, attr] of Object.entries(EmailVerificationToken.rawAttributes)) columns[attr.field || name] = { ...attr };
    await queryInterface.createTable(EmailVerificationToken.tableName, columns);
    for (const index of EmailVerificationToken.options.indexes) await queryInterface.addIndex(EmailVerificationToken.tableName, index.fields, index);
    const name = queryInterface.quoteIdentifier(EmailVerificationToken.tableName);
    await queryInterface.sequelize.query(`ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY`);
    const [roles] = await queryInterface.sequelize.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')");
    if (roles.length) await queryInterface.sequelize.query(`REVOKE ALL ON TABLE public.${name} FROM ${roles.map((role) => queryInterface.quoteIdentifier(role.rolname)).join(', ')}`);
  },
  async down(queryInterface) { await queryInterface.dropTable('email_verification_tokens'); },
};
