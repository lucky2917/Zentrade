import { sendMail } from "./mailer.js";
import { escapeHtml } from "../utils/escapeHtml.js";

const CONFIDENCE_SCORE = { HIGH: 85, MEDIUM: 55, LOW: 25 };
const ALERT_THRESHOLD = 70;

const passesAlertThreshold = (analysis) =>
    analysis.action !== "HOLD" && (CONFIDENCE_SCORE[analysis.confidence] ?? 0) >= ALERT_THRESHOLD;

// traderNote is LLM output shaped by external news headlines — escape it
const buildAlertHtml = (symbol, analysis) => `
<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 24px;">
  <h2 style="margin-top: 0;">${escapeHtml(symbol)} — ${escapeHtml(analysis.action)}</h2>
  <p><strong>Confidence:</strong> ${escapeHtml(analysis.confidence)}</p>
  <p><strong>Entry:</strong> ₹${escapeHtml(analysis.entry)} &nbsp; <strong>Target:</strong> ₹${escapeHtml(analysis.target)} &nbsp; <strong>Stop:</strong> ₹${escapeHtml(analysis.stopLoss)}</p>
  <p>${escapeHtml(analysis.traderNote)}</p>
  <p style="color: #888; font-size: 12px; margin-top: 32px;">ZenTrade • Auto-generated alert</p>
</div>
`;

const sendTradeAlert = async (symbol, analysis) => {
    await sendMail(
        process.env.ALERT_EMAIL_TO,
        `ZenTrade — ${analysis.action} signal on ${symbol} (${analysis.confidence})`,
        buildAlertHtml(symbol, analysis)
    );
};

export { sendTradeAlert, passesAlertThreshold, CONFIDENCE_SCORE, ALERT_THRESHOLD };
