import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { validate, required, isEmail, minLength } from "../middleware/validate.js";

const router = Router();

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
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

        res.status(201).json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                balancePaise: Number(user.balance_paise),
            },
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/login", validate({ email: [required], password: [required] }), async (req, res) => {
    try {
        const { email, password } = req.body;

        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const user = result.rows[0];
        if (!user.password_hash) {
            return res.status(401).json({ error: "This account uses Google login" });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                balancePaise: Number(user.balance_paise),
            },
        });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

router.post("/google", async (req, res) => {
    try {
        const { accessToken } = req.body;

        if (!accessToken) {
            return res.status(400).json({ error: "Google access token is required" });
        }

        const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!profileRes.ok) {
            return res.status(401).json({ error: "Invalid Google token" });
        }

        const profile = await profileRes.json();
        const googleId = profile.sub;
        const email = profile.email;
        const name = profile.name || email.split("@")[0];

        if (!email) {
            return res.status(400).json({ error: "Could not get email from Google" });
        }

        let user;

        const existingByGoogle = await pool.query(
            "SELECT * FROM users WHERE google_id = $1",
            [googleId]
        );

        if (existingByGoogle.rows.length > 0) {
            user = existingByGoogle.rows[0];
        } else {
            const existingByEmail = await pool.query(
                "SELECT * FROM users WHERE email = $1",
                [email]
            );

            if (existingByEmail.rows.length > 0) {
                user = existingByEmail.rows[0];
                await pool.query(
                    "UPDATE users SET google_id = $1, name = COALESCE(name, $2) WHERE id = $3",
                    [googleId, name, user.id]
                );
                user.google_id = googleId;
                user.name = user.name || name;
            } else {
                const result = await pool.query(
                    "INSERT INTO users (email, google_id, name) VALUES ($1, $2, $3) RETURNING *",
                    [email, googleId, name]
                );
                user = result.rows[0];
            }
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                balancePaise: Number(user.balance_paise),
            },
        });
    } catch (err) {
        res.status(500).json({ error: "Google authentication failed" });
    }
});

export default router;

/*
 * auth routes — handles signup, login, and google oauth. the /google
 * endpoint takes the access token from google's sign-in popup, hits
 * google's userinfo api to get the user's email and name, then either
 * finds or creates the user in our db. new users get ten lakh virtual
 * balance automatically. all three endpoints return a jwt + user object.
 * mounted at /api/auth in index.js.
 */
