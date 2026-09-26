import { config } from '../config.js';
import { PublicTestError } from './errors.js';

export const mailConfigured = () => Boolean(config.brevo.apiKey && config.brevo.senderEmail);

/**
 * Sends one transactional email through Brevo's HTTP API. Without Brevo
 * credentials, a development server prints the message to its console instead
 * so sign-in can still be tried locally; a production server refuses.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new PublicTestError(503, 'Email sign-in is not configured on this server yet.');
    }
    console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n[mail:dev] ${text}\n`);
    return;
  }
  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': config.brevo.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: config.brevo.senderEmail, name: config.brevo.senderName },
        to: [{ email: to }],
        subject,
        textContent: text,
        htmlContent: html
      })
    });
  } catch (error) {
    console.error('Brevo request failed:', error.message);
    throw new PublicTestError(502, 'The sign-in email could not be sent. Try again in a moment.');
  }
  if (!response.ok) {
    console.error('Brevo refused the email:', response.status, await response.text().catch(() => ''));
    throw new PublicTestError(502, 'The sign-in email could not be sent. Try again in a moment.');
  }
}
