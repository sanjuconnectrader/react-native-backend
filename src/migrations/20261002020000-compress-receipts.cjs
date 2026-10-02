'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('receipts');
    if (!columns.snapshot) return; // Fresh installs already use the compressed schema.
    if (!columns.snapshot_compressed) {
      await queryInterface.addColumn('receipts', 'snapshot_compressed', { type: Sequelize.BLOB, allowNull: true });
    }
    const { encodeReceipt } = await import('../utils/receipt-codec.js');
    for (;;) {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id, snapshot FROM receipts WHERE snapshot_compressed IS NULL LIMIT 100'
      );
      if (!rows.length) break;
      for (const row of rows) {
        await queryInterface.sequelize.query(
          'UPDATE receipts SET snapshot_compressed = $payload WHERE id = $id',
          { bind: { id: row.id, payload: encodeReceipt(row.snapshot) } }
        );
      }
    }
    await queryInterface.changeColumn('receipts', 'snapshot_compressed', { type: Sequelize.BLOB, allowNull: false });
    await queryInterface.removeColumn('receipts', 'snapshot');
  },
  async down(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('receipts');
    if (columns.snapshot) return;
    await queryInterface.addColumn('receipts', 'snapshot', { type: Sequelize.JSONB, allowNull: true });
    const { decodeReceipt } = await import('../utils/receipt-codec.js');
    for (;;) {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id, snapshot_compressed FROM receipts WHERE snapshot IS NULL LIMIT 100'
      );
      if (!rows.length) break;
      for (const row of rows) {
        await queryInterface.sequelize.query(
          'UPDATE receipts SET snapshot = CAST(:snapshot AS jsonb) WHERE id = :id',
          { replacements: { id: row.id, snapshot: JSON.stringify(decodeReceipt(row.snapshot_compressed)) } }
        );
      }
    }
    await queryInterface.changeColumn('receipts', 'snapshot', { type: Sequelize.JSONB, allowNull: false });
    await queryInterface.removeColumn('receipts', 'snapshot_compressed');
  },
};
