import jwt from "jsonwebtoken";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";

const auth = async (req, res, next) => {
    // Prefer HttpOnly cookie; fall back to Authorization header for API clients
    const token = req.cookies?.token ||
        (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.split(" ")[1]
            : null);

    if (!token) return res.status(401).json({ error: "No token provided" });

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }

    // Blocklist check — fail open if Redis is unavailable so a Redis hiccup
    // doesn't log out every active user
    if (decoded.jti) {
        try {
            const blocked = await redis.get(`jti:blocklist:${decoded.jti}`);
            if (blocked) return res.status(401).json({ error: "Token revoked" });
        } catch (err) {
            logger.error("Auth", "Redis blocklist check failed, allowing through", { error: err.message });
        }
    }

    req.userId = decoded.userId;
    next();
};

export default auth;
