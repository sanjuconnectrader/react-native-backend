import 'dotenv/config';

const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET', 'OTP_SECRET'];
export function validateEnv() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (process.env.JWT_SECRET.length < 32 || process.env.OTP_SECRET.length < 32) {
    throw new Error('JWT_SECRET and OTP_SECRET must each have at least 32 characters');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
    throw new Error('RESEND_API_KEY or SMTP configuration is required in production');
  }
}

export const config = {
  port: Number(process.env.PORT || 5000),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'restaurant_pos',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' || (process.env.DB_SSL !== 'false' && /\.supabase\.(com|co)$/.test(process.env.DB_HOST || '')),
    sslCaFile: process.env.DB_SSL_CA_FILE,
  },
  jwtSecret: process.env.JWT_SECRET,
  otpSecret: process.env.OTP_SECRET,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
};
