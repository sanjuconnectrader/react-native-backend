require('dotenv').config();
const { readFileSync } = require('node:fs');
const ssl = process.env.DB_SSL === 'true' || (process.env.DB_SSL !== 'false' && /\.supabase\.(com|co)$/.test(process.env.DB_HOST || ''));
const dialectOptions = ssl ? { ssl: { rejectUnauthorized: true,
  ...(process.env.DB_SSL_CA_FILE ? { ca: readFileSync(process.env.DB_SSL_CA_FILE, 'utf8') } : {}) } } : {};
module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    dialectOptions
  },
  test: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    dialectOptions
  },
  production: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    dialect: 'postgres',
    dialectOptions
  }
};
