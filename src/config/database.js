import { Sequelize } from 'sequelize';
import { readFileSync } from 'node:fs';
import { config } from './env.js';

export const db = new Sequelize(config.db.database, config.db.username, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'postgres',
  dialectOptions: config.db.ssl ? { ssl: { rejectUnauthorized: true,
    ...(config.db.sslCaFile ? { ca: readFileSync(config.db.sslCaFile, 'utf8') } : {}) } } : {},
  logging: false,
  pool: { max: 3, min: 0, idle: 10000 },
  define: { underscored: true, freezeTableName: true },
});
