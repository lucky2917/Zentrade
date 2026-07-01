import { Router } from "express";
import { generateAuthCodeUrl, verifyOAuthState, generateAccessToken, getTokenExpiry, isConfigured } from "../services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, stop as stopFyersWebSocket } from "../services/fyers/fyersWebSocket.js";
import { sendReauthSuccessEmail } from "../services/fyers/authWatchdog.js";
import auth from "../middleware/auth.js";
import logger from "../utils/logger.js";

const router = Router();
const frontendUrl = () => process.env.FRONTEND_URL || "http://localhost:5173";

router.get("/status", auth, async (req, res) => {
    const expiresAt = await getTokenExpiry();
    res.json({ configured: isConfigured(), expiresAt });
});

router.get("/reauth", auth, async (req, res) => {
    try {
        const url = await generateAuthCodeUrl();
        res.redirect(url);
    } catch (err) {
        logger.error("FyersRoutes", "Failed to generate auth URL", { error: err.message });
        res.status(500).send("Fyers not configured");
    }
});

router.get("/callback", async (req, res) => {
    const { auth_code: authCode, s, state } = req.query;

    if (s !== "ok" || !authCode) {
        logger.error("FyersRoutes", "Callback missing auth_code or not ok", { query: req.query });
        return res.redirect(`${frontendUrl()}/reauth?error=missing_code`);
    }

    const stateValid = await verifyOAuthState(state);
    if (!stateValid) {
        logger.error("FyersRoutes", "Callback failed CSRF state check", { state });
        return res.redirect(`${frontendUrl()}/reauth?error=invalid_state`);
    }

    try {
        await generateAccessToken(authCode);

        stopFyersWebSocket();
        await connectFyersWebSocket();

        await sendReauthSuccessEmail();

        res.redirect(`${frontendUrl()}/reauth?reauth=success`);
    } catch (err) {
        logger.error("FyersRoutes", "Failed to exchange auth code", { error: err.message });
        res.redirect(`${frontendUrl()}/reauth?error=exchange_failed`);
    }
});

export default router;
