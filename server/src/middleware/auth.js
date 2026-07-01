import jwt from "jsonwebtoken";
import redis from "../config/redis.js";

const auth = async (req, res, next) => {
    // Prefer HttpOnly cookie; fall back to Authorization header for API clients
    const token = req.cookies?.token ||
        (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.split(" ")[1]
            : null);

    if (!token) return res.status(401).json({ error: "No token provided" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.jti) {
            const blocked = await redis.get(`jti:blocklist:${decoded.jti}`);
            if (blocked) return res.status(401).json({ error: "Token revoked" });
        }

        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
};

export default auth;
