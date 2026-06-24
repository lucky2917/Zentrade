import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { isConfigured } from "./fyersAuth.js";
import { sendMail } from "../mailer.js";
import { setBudgetAlertHandler, resetDailyBudget } from "./rateLimiter.js";

const TOKEN_EXPIRY_KEY = "fyers:token_expiry";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const URGENCY_LEVELS = {
    FIRST: { emoji: "🔐", subjectSuffix: "Re-auth needed (7 hrs left)" },
    URGENT: { emoji: "⚠️", subjectSuffix: "Re-auth in 4 hrs" },
    CRITICAL: { emoji: "🚨", subjectSuffix: "URGENT: 30 mins to token expiry" },
};

const formatIST = (date) => date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

const formatRemaining = (ms) => {
    if (ms == null) return "No active token found — please re-authenticate.";
    if (ms <= 0) return "Token has already expired.";
    const totalMinutes = Math.round(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `Time remaining: ${hours}h ${minutes}m` : `Time remaining: ${minutes}m`;
};

const buildAlertHtml = (headline, remainingLabel) => `
<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 24px; text-align: center;">
  <h2 style="margin-top: 0;">${headline}</h2>
  <p>Token expires at <strong>3:00 AM IST</strong>.</p>
  <p>${remainingLabel}</p>
  <a href="${FRONTEND_URL}/reauth" style="display: inline-block; margin: 24px 0; padding: 14px 28px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">Re-authenticate Now →</a>
  <p style="color: #888; font-size: 12px; margin-top: 32px;">ZenTrade • Auto-generated alert</p>
</div>
`;

const sendReauthEmail = async (urgencyLevel) => {
    if (!isConfigured()) return;

    const level = URGENCY_LEVELS[urgencyLevel];
    if (!level) return;

    const expiryRaw = await redis.get(TOKEN_EXPIRY_KEY);
    const remainingMs = expiryRaw ? Number(expiryRaw) - Date.now() : null;

    const subject = `${level.emoji} ZenTrade — ${level.subjectSuffix}`;
    const html = buildAlertHtml("Fyers Re-authentication Needed", formatRemaining(remainingMs));

    await sendMail(process.env.ALERT_EMAIL_TO, subject, html);
    logger.warn("AuthWatchdog", `Sent re-auth reminder (${urgencyLevel})`, {
        remainingMs,
        currentTimeIST: formatIST(new Date()),
    });
};

const sendBudgetAlert = async (callsRemaining) => {
    const subject = `🚨 ZenTrade — REST budget critical (${callsRemaining} calls left)`;
    const html = buildAlertHtml("Fyers REST Budget Critical", `Only ${callsRemaining} REST calls left today.`);

    await sendMail(process.env.ALERT_EMAIL_TO, subject, html);
    logger.error("AuthWatchdog", "Sent budget critical alert", { callsRemaining });
};

const sendReauthSuccessEmail = async () => {
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 24px; text-align: center;">
  <h2 style="margin-top: 0;">✅ Re-authentication Successful</h2>
  <p>Token valid until <strong>3:00 AM IST</strong> tomorrow.</p>
  <p>Next reminder at 8:00 PM.</p>
  <p style="color: #888; font-size: 12px; margin-top: 32px;">ZenTrade • Auto-generated alert</p>
</div>
`;
    await sendMail(process.env.ALERT_EMAIL_TO, "✅ ZenTrade — Re-auth successful", html);
};

const startWatchdog = () => {
    setBudgetAlertHandler(sendBudgetAlert);

    cron.schedule("0 20 * * 1-5", () => sendReauthEmail("FIRST"), { timezone: "Asia/Kolkata" });
    cron.schedule("0 23 * * 1-5", () => sendReauthEmail("URGENT"), { timezone: "Asia/Kolkata" });
    cron.schedule("30 2 * * 1-5", () => sendReauthEmail("CRITICAL"), { timezone: "Asia/Kolkata" });
    cron.schedule("31 3 * * 1-5", resetDailyBudget, { timezone: "Asia/Kolkata" });

    logger.info("AuthWatchdog", "Scheduled gmail reminders at 8pm, 11pm, 2:30am IST, daily REST budget reset at 3:31am");
};

export { startWatchdog, sendReauthEmail, sendBudgetAlert, sendReauthSuccessEmail };
