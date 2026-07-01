import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { validate, required, isEmail, minLength } from "../middleware/validate.js";
import auth from "../middleware/auth.js";

const router = Router();

const isProd = process.env.NODE_ENV === "production";

const COOKIE_OPTS = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
};

const issueToken = (userId) => {
    const jti = crypto.randomBytes(16).toString("hex");
    return jwt.sign({ userId, jti }, process.env.JWT_SECRET, { expiresIn: "7d" });
};

const setAuthCookie = (res, token) => res.cookie("token", token, COOKIE_OPTS);

router.post("/signup", validate({ email: [required, isEmail], password: [required, minLength(8)] }), async (req, res) => {
    try {
        const { email, password } = req.body;

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
        setAuthCookie(res, issueToken(user.id));

        res.status(201).json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch {
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/login", validate({ email: [required], password: [required] }), async (req, res) => {
    try {
        const { email, password } = req.body;

        const result = await pool.query(
            "SELECT id, email, name, password_hash, balance_paise FROM users WHERE email = $1",
            [email]
        );

        const user = result.rows[0] || null;
        // Always run bcrypt regardless of whether user exists to prevent timing-based email enumeration
        const valid = await bcrypt.compare(password, user?.password_hash || "$2b$12$dummyhashfortimingattackprevxx");

        if (!user || !valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (!user.password_hash) {
            return res.status(401).json({ error: "This account uses Google login" });
        }

        setAuthCookie(res, issueToken(user.id));

        res.json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch {
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
        const email = profile.email;

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

        setAuthCookie(res, issueToken(user.id));

        res.json({
            user: { id: user.id, email: user.email, name: user.name, balancePaise: Number(user.balance_paise) },
        });
    } catch {
        res.status(500).json({ error: "Google authentication failed" });
    }
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
    } catch {
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/logout", auth, async (req, res) => {
    const rawToken = req.cookies?.token;
    if (rawToken) {
        try {
            const decoded = jwt.decode(rawToken);
            if (decoded?.jti && decoded?.exp) {
                const ttl = Math.max(1, decoded.exp - Math.floor(Date.now() / 1000));
                await redis.set(`jti:blocklist:${decoded.jti}`, "1", "EX", ttl);
            }
        } catch { /* ignore decode errors */ }
    }

    res.clearCookie("token", { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax" });
    res.json({ success: true });
});

export default router;
