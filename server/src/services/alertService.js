import { sendMail } from "./mailer.js";

const CONFIDENCE_SCORE = { HIGH: 85, MEDIUM: 55, LOW: 25 };
const ALERT_THRESHOLD = 70;

const passesAlertThreshold = (analysis) => (CONFIDENCE_SCORE[analysis.confidence] ?? 0) >= ALERT_THRESHOLD;

const buildAlertHtml = (symbol, analysis) => `
<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 24px;">
  <h2 style="margin-top: 0;">${symbol} — ${analysis.action}</h2>
  <p><strong>Confidence:</strong> ${analysis.confidence}</p>
  <p><strong>Entry:</strong> ₹${analysis.entry} &nbsp; <strong>Target:</strong> ₹${analysis.target} &nbsp; <strong>Stop:</strong> ₹${analysis.stopLoss}</p>
  <p>${analysis.traderNote ?? ""}</p>
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
