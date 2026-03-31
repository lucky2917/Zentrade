import jwt from "jsonwebtoken";

const auth = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "No token provided" });
    }

    try {
        const token = header.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
};

export default auth;

/*
 * jwt auth middleware. grabs the bearer token from request headers,
 * verifies it, and sticks the userId onto req so downstream handlers
 * know who's making the request. used by trade, orders, portfolio,
 * and watchlist routes — basically anything that needs a logged in user.
 */
