import { config } from '../config.js';
import { otpSends, registrations, resultMailSends } from '../db/index.js';

/**
 * The day's emails, shared by sign-in codes (auth/account-login.js) and
 * results emails (services/result-mail-service.js). Brevo's free plan sends
 * 300 a day; `otp.dailyLimit` (295) is all of them together, and results may
 * use at most `resultMail.dailyLimit` (200) of it, so codes always keep the
 * rest. "A day" is the last 24 hours, as for the codes.
 */
const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

/** Results emails counted today: sent in the last day, and those still waiting to go - already promised. */
export async function resultMailsToday() {
  const [sent, waiting] = await Promise.all([
    resultMailSends().countDocuments({ createdAt: { $gt: dayAgo() } }),
    registrations().countDocuments({ 'resultMail.status': { $in: ['queued', 'sending'] } })
  ]);
  return sent + waiting;
}

/** What today's emails have used, and how many results emails may still be queued. */
export async function mailAllowance() {
  const [codes, results] = await Promise.all([otpSends().countDocuments({ createdAt: { $gt: dayAgo() } }), resultMailsToday()]);
  const left = Math.max(0, Math.min(config.resultMail.dailyLimit - results, config.otp.dailyLimit - codes - results));
  return { left, results, codes, resultsLimit: config.resultMail.dailyLimit, dailyLimit: config.otp.dailyLimit };
}
