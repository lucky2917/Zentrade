import { ipKeyGenerator } from "express-rate-limit";

// Rate-limit keying cannot use req.ip here: request paths have different
// proxy depths (client → Vercel → Cloudflare → Render vs direct → Cloudflare
// → Render), so no fixed trust-proxy hop count resolves the real client on
// both. Deploy logs confirmed hop counting lands on Cloudflare/Vercel IPs.
//
// Instead key on the LEFTMOST X-Forwarded-For entry. Vercel and Cloudflare
// both set/propagate the real client there. A direct caller can forge it,
// which only lets them dodge their own limit (same as rotating IPs) — it
// cannot push other users into a shared bucket. Login brute-force is
// additionally limited per email in index.js.
const clientIp = (req) => {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string") {
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    return req.ip;
};

// IPv6-safe key (buckets v6 clients by /56 so one host can't rotate through
// a whole subnet), via express-rate-limit's own helper
const clientIpKey = (req) => ipKeyGenerator(clientIp(req));

export { clientIp, clientIpKey };
