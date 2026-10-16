import { Op } from 'sequelize';
import { OTPVerification, EmailVerificationToken, RefreshSession } from '../models/index.js';

const DAY = 86_400_000;

export async function pruneExpiredAuthData(now = new Date()) {
  const otpCutoff = new Date(now.getTime() - DAY);
  const sessionCutoff = new Date(now.getTime() - 7 * DAY);
  const [otps, links, sessions] = await Promise.all([
    OTPVerification.destroy({ where: { expiresAt: { [Op.lt]: otpCutoff } } }),
    EmailVerificationToken.destroy({ where: { expiresAt: { [Op.lt]: otpCutoff } } }),
    RefreshSession.destroy({ where: { [Op.or]: [
      { expiresAt: { [Op.lt]: now } },
      { revokedAt: { [Op.lt]: sessionCutoff } },
    ] } }),
  ]);
  return { otps, links, sessions };
}

export function startDatabaseMaintenance() {
  const run = () => pruneExpiredAuthData().catch((error) => console.error('Auth data cleanup failed:', error));
  void run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
