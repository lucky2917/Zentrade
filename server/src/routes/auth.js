import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { validate, required, isEmail, minLength } from "../middleware/validate.js";
import auth from "../middleware/auth.js";
import logger from "../utils/logger.js";

const router = Router();

const isProd = process.env.NODE_ENV === "production";

// Emails are compared with = in SQL, so case/whitespace variants would fork
// into duplicate accounts (and split balances across password vs Google login)
const normaliseEmail = (email) => String(email).trim().toLowerCase();

const COOKIE_OPTS = {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
};

// H4: short-lived access token (15 min) + long-lived refresh token (7 days)
const ACCESS_TTL = "15m";
const REFRESH_TTL_SECS = 7 * 24 * 60 * 60;

const issueAccessToken = (userId) => {
    const jti = crypto.randomBytes(16).toString("hex");
    return { token: jwt.sign({ userId, jti }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL }), jti };
};

const issueRefreshToken = (userId) => {
    const jti = crypto.randomBytes(16).toString("hex");
    return { token: jwt.sign({ userId, jti, type: "refresh" }, process.env.JWT_SECRET, { expiresIn: REFRESH_TTL_SECS }), jti };
};

const setAuthCookies = (res, userId) => {
    const access = issueAccessToken(userId);
    const refresh = issueRefreshToken(userId);
    res.cookie("token", access.token, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
    res.cookie("refreshToken", refresh.token, { ...COOKIE_OPTS, maxAge: REFRESH_TTL_SECS * 1000 });
    return { access, refresh };
};

const blacklistToken = async (rawToken) => {
    if (!rawToken) return;
    try {
        const decoded = jwt.decode(rawToken);
        if (decoded?.jti && decoded?.exp) {
            const ttl = Math.max(1, decoded.exp - Math.floor(Date.now() / 1000));
            await redis.set(`jti:blocklist:${decoded.jti}`, "1", "EX", ttl);
        }
    } catch { /* ignore */ }
};

router.post("/signup", validate({ email: [required, isEmail], password: [required, minLength(8)] }), async (req, res) => {
    try {
        const { password } = req.body;
        const email = normaliseEmail(req.body.email);

        const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: "Email already registered" });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, name, balance_paise",
            [email, passwordHash]
        );

        const user = result.rows[0];
        setAuthCookies(res, user.id);

        res.status(201).json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch (err) {
        logger.error("Auth", "Signup error", { error: err.message });
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/login", validate({ email: [required], password: [required] }), async (req, res) => {
    try {
        const { password } = req.body;
        const email = normaliseEmail(req.body.email);

        const result = await pool.query(
            "SELECT id, email, name, password_hash, balance_paise FROM users WHERE email = $1",
            [email]
        );

        const user = result.rows[0] || null;
        // Always run bcrypt regardless of whether user exists to prevent timing-based email enumeration
        const valid = await bcrypt.compare(password, user?.password_hash || "$2b$12$dummyhashfortimingattackprevxx");

        // M2 fix: never distinguish between "wrong password" and "Google-only account" —
        // both return the same generic error so auth method can't be enumerated.
        if (!user || !valid || !user.password_hash) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        setAuthCookies(res, user.id);

        res.json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch (err) {
        logger.error("Auth", "Login error", { error: err.message });
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/google", async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: "Google authorization code is required" });

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: "postmessage",
                grant_type: "authorization_code",
            }),
        });

        if (!tokenRes.ok) return res.status(401).json({ error: "Invalid Google authorization code" });

        const { access_token: accessToken } = await tokenRes.json();

        const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!profileRes.ok) return res.status(401).json({ error: "Invalid Google token" });

        const profile = await profileRes.json();
        const googleId = profile.sub;
        const email = profile.email ? normaliseEmail(profile.email) : null;

        if (!googleId) return res.status(400).json({ error: "Could not get user ID from Google" });
        if (!email) return res.status(400).json({ error: "Could not get email from Google" });
        if (!profile.email_verified) return res.status(401).json({ error: "Google email not verified" });

        const name = profile.name || email.split("@")[0];

        let user;

        const existingByGoogle = await pool.query(
            "SELECT id, email, name, balance_paise FROM users WHERE google_id = $1",
            [googleId]
        );

        if (existingByGoogle.rows.length > 0) {
            user = existingByGoogle.rows[0];
        } else {
            const existingByEmail = await pool.query(
                "SELECT id, email, name, balance_paise FROM users WHERE email = $1",
                [email]
            );

            if (existingByEmail.rows.length > 0) {
                user = existingByEmail.rows[0];
                await pool.query(
                    "UPDATE users SET google_id = $1, name = COALESCE(name, $2) WHERE id = $3",
                    [googleId, name, user.id]
                );
                user.name = user.name || name;
            } else {
                const insertResult = await pool.query(
                    "INSERT INTO users (email, google_id, name) VALUES ($1, $2, $3) RETURNING id, email, name, balance_paise",
                    [email, googleId, name]
                );
                user = insertResult.rows[0];
            }
        }

        setAuthCookies(res, user.id);

        res.json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch (err) {
        logger.error("Auth", "Google auth error", { error: err.message });
        res.status(500).json({ error: "Google authentication failed" });
    }
});

// H4: refresh endpoint — verifies refreshToken cookie, issues new access token
router.post("/refresh", async (req, res) => {
    const rawRefresh = req.cookies?.refreshToken;
    if (!rawRefresh) return res.status(401).json({ error: "No refresh token" });

    let decoded;
    try {
        decoded = jwt.verify(rawRefresh, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: "Invalid refresh token" });
    }

    if (decoded.type !== "refresh") {
        return res.status(401).json({ error: "Invalid token type" });
    }

    if (decoded.jti) {
        try {
            const blocked = await redis.get(`jti:blocklist:${decoded.jti}`);
            if (blocked) return res.status(401).json({ error: "Refresh token revoked" });
        } catch (err) {
            logger.error("Auth", "Redis blocklist check failed on refresh, allowing through", { error: err.message });
        }
    }

    // A refresh token can outlive its account by up to 7 days — make sure the
    // user still exists before minting a fresh access token
    try {
        const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [decoded.userId]);
        if (rows.length === 0) return res.status(401).json({ error: "Invalid refresh token" });
    } catch (err) {
        logger.error("Auth", "Refresh user lookup failed", { error: err.message });
        return res.status(500).json({ error: "Server error" });
    }

    const access = issueAccessToken(decoded.userId);
    res.cookie("token", access.token, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
    res.json({ ok: true });
});

router.get("/me", auth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, email, name, balance_paise FROM users WHERE id = $1",
            [req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        const u = result.rows[0];
        res.json({ id: u.id, email: u.email, name: u.name, balancePaise: Number(u.balance_paise) });
    } catch (err) {
        logger.error("Auth", "/me error", { error: err.message });
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/logout", auth, async (req, res) => {
    await blacklistToken(req.cookies?.token);
    await blacklistToken(req.cookies?.refreshToken);

    res.clearCookie("token", { httpOnly: true, secure: isProd, sameSite: "lax" });
    res.clearCookie("refreshToken", { httpOnly: true, secure: isProd, sameSite: "lax" });
    res.json({ success: true });
});

export default router;
