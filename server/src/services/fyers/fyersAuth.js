import crypto from "crypto";
import { fyersModel } from "fyers-api-v3";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";

const ACCESS_TOKEN_KEY = "fyers:access_token";
const TOKEN_EXPIRY_KEY = "fyers:token_expiry";
const OAUTH_STATE_KEY = "fyers:oauth_state";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const clientId = process.env.FYERS_CLIENT_ID;
const secretKey = process.env.FYERS_SECRET_KEY;
const redirectUri = process.env.FYERS_REDIRECT_URI;

const fyers = new fyersModel({ enableLogging: false });
if (clientId) fyers.setAppId(clientId);
if (redirectUri) fyers.setRedirectUrl(redirectUri);

const isConfigured = () => Boolean(clientId && secretKey && redirectUri);

const nextThreeAmIST = (from = new Date()) => {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const driftMs = IST_OFFSET_MS + from.getTimezoneOffset() * 60 * 1000;
    const istNow = new Date(from.getTime() + driftMs);

    const istExpiry = new Date(istNow);
    istExpiry.setHours(3, 0, 0, 0);
    if (istNow.getTime() >= istExpiry.getTime()) {
        istExpiry.setDate(istExpiry.getDate() + 1);
    }

    return istExpiry.getTime() - driftMs;
};

const generateAuthCodeUrl = async () => {
    if (!isConfigured()) {
        throw new Error("Fyers credentials not configured (FYERS_CLIENT_ID/SECRET_KEY/REDIRECT_URI)");
    }
    const state = crypto.randomBytes(16).toString("hex");
    await redis.set(OAUTH_STATE_KEY, state, "EX", OAUTH_STATE_TTL_SECONDS);
    return fyers.generateAuthCode({ state });
};

const verifyOAuthState = async (state) => {
    const expected = await redis.get(OAUTH_STATE_KEY);
    if (!expected || !state || expected !== state) return false;
    await redis.del(OAUTH_STATE_KEY);
    return true;
};

const generateAccessToken = async (authCode) => {
    if (!isConfigured()) {
        throw new Error("Fyers credentials not configured (FYERS_CLIENT_ID/SECRET_KEY/REDIRECT_URI)");
    }

    const response = await fyers.generate_access_token({
        client_id: clientId,
        secret_key: secretKey,
        auth_code: authCode,
    });

    if (response.s !== "ok" || !response.access_token) {
        throw new Error(`Fyers auth failed: ${JSON.stringify(response)}`);
    }

    const expiryMs = nextThreeAmIST();
    const ttlSeconds = Math.max(60, Math.floor((expiryMs - Date.now()) / 1000));

    await redis.set(ACCESS_TOKEN_KEY, response.access_token, "EX", ttlSeconds);
    await redis.set(TOKEN_EXPIRY_KEY, String(expiryMs));

    fyers.setAccessToken(response.access_token);

    logger.info("FyersAuth", `Token stored. Expires at 3:00 AM IST`, {
        expiry: new Date(expiryMs).toISOString(),
    });

    return response.access_token;
};

const getAccessToken = async () => redis.get(ACCESS_TOKEN_KEY);

const getWebSocketToken = async () => {
    const token = await getAccessToken();
    if (!token || !clientId) return null;
    return `${clientId}:${token}`;
};

const getTokenExpiry = async () => {
    const expiry = await redis.get(TOKEN_EXPIRY_KEY);
    return expiry ? Number(expiry) : null;
};

const initFyersAuth = async () => {
    if (!isConfigured()) {
        logger.info("FyersAuth", "Fyers credentials not configured, skipping auth");
        return;
    }

    const existingToken = await getAccessToken();
    if (existingToken) {
        fyers.setAccessToken(existingToken);
        logger.info("FyersAuth", "Existing valid token found in Redis, skipping auth flow");
        return;
    }

    const authCode = process.env.FYERS_AUTH_CODE;
    if (!authCode) {
        logger.warn("FyersAuth", "No cached token and no FYERS_AUTH_CODE set. Visit this URL to log in:", {
            url: await generateAuthCodeUrl(),
        });
        return;
    }

    try {
        await generateAccessToken(authCode);
    } catch (err) {
        logger.error("FyersAuth", "Failed to exchange auth code for access token", { error: err.message });
    }
};

export {
    fyers,
    initFyersAuth,
    generateAuthCodeUrl,
    verifyOAuthState,
    generateAccessToken,
    getAccessToken,
    getWebSocketToken,
    getTokenExpiry,
    nextThreeAmIST,
    isConfigured,
};
