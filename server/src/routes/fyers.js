import { Router } from "express";
import { generateAuthCodeUrl, generateAccessToken, getTokenExpiry, isConfigured } from "../services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, stop as stopFyersWebSocket } from "../services/fyers/fyersWebSocket.js";
import { sendReauthSuccessEmail } from "../services/fyers/authWatchdog.js";
import logger from "../utils/logger.js";

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

router.get("/status", async (req, res) => {
    const expiresAt = await getTokenExpiry();
    res.json({ configured: isConfigured(), expiresAt });
});

router.get("/reauth", (req, res) => {
    try {
        const url = generateAuthCodeUrl();
        res.redirect(url);
    } catch (err) {
        logger.error("FyersRoutes", "Failed to generate auth URL", { error: err.message });
        res.status(500).send("Fyers not configured");
    }
});

router.get("/callback", async (req, res) => {
    const { auth_code: authCode, s } = req.query;

    if (s !== "ok" || !authCode) {
        logger.error("FyersRoutes", "Callback missing auth_code or not ok", { query: req.query });
        return res.redirect(`${FRONTEND_URL}/reauth?error=missing_code`);
    }

    try {
        await generateAccessToken(authCode);

        stopFyersWebSocket();
        await connectFyersWebSocket();

        await sendReauthSuccessEmail();

        res.redirect(`${FRONTEND_URL}/reauth?reauth=success`);
    } catch (err) {
        logger.error("FyersRoutes", "Failed to exchange auth code", { error: err.message });
        res.redirect(`${FRONTEND_URL}/reauth?error=exchange_failed`);
    }
});

export default router;
