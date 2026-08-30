import Redis from "ioredis";

// Getting a Fyers token onto the machine that is actually running.
//
// THE PROBLEM THIS SOLVES, precisely:
//
// Fyers registers ONE OAuth redirect URI per app. In this deployment it is the
// hosted backend, so the whole exchange — auth code, token mint, and the CSRF
// state check that guards it — happens over there and the token is written to
// THAT backend's Redis. A developer machine running the same code against its
// own Redis has no token and never will, no matter how many times the operator
// re-authenticates, because the callback never reaches it.
//
// The operator was previously expected to remember a separate sync command.
// That is not a workflow, it is a trap: it is needed exactly once a day, at the
// one moment the operator is busy, and forgetting it produces a preflight
// failure that says "re-authenticate" to someone who just did.
//
// So the startup path acquires the token itself. Authenticate, start, run.
//
// Safety rules this module keeps:
//   · only the two auth keys move — never the price cache, the rate-limit
//     budget counters or the market-data ownership lease
//   · the real remaining TTL is preserved, so a borrowed token still expires
//     at 03:00 IST like every other copy of it
//   · it refuses to sync a Redis onto itself
//   · nothing here logs, returns or throws a connection string or a token

const ACCESS_TOKEN_KEY = "fyers:access_token";
const TOKEN_EXPIRY_KEY = "fyers:token_expiry";
const CONNECT_TIMEOUT_MS = 10_000;

// Preferred name first; the older one is still accepted because it is what the
// standalone script documented and what an operator may already have set.
export const TOKEN_SOURCE_VARS = ["FYERS_TOKEN_SOURCE_REDIS_URL", "PROD_REDIS_URL"];

export const STATUS = {
    PRESENT: "PRESENT",           // a live token is already here
    SYNCED: "SYNCED",             // pulled one from the source
    NO_SOURCE: "NO_SOURCE",       // none here, and no source configured
    SOURCE_EMPTY: "SOURCE_EMPTY", // source has no live token either
    SAME_REDIS: "SAME_REDIS",     // source is this Redis; nothing to do
    FAILED: "FAILED",             // the source could not be reached
    LOCAL_MINT: "LOCAL_MINT",     // this backend owns the callback; just log in
    MALFORMED: "MALFORMED",       // present, but not a token Fyers can use
    REJECTED: "REJECTED",         // well-formed, and Fyers refuses it
};

// A Fyers access token is a JWT, and the market-data socket decodes it to read
// `hsm_key`. Checking that here is not belt-and-braces: a value that is present
// with a healthy TTL but is not a usable token is exactly the case that let
// startup report a confident READY while the feed could not connect at all.
//
// The socket's own error for this is
//   Invalid JWT: "hsm_key" missing or token is invalid
// which arrives at connect time, several stages after anything could act on it.
export const inspectToken = (token) => {
    if (typeof token !== "string" || !token) {
        return { ok: false, reason: "no token" };
    }
    const segments = token.split(".");
    if (segments.length !== 3) {
        return { ok: false,
                 reason: `not a JWT (${segments.length} segment(s)); the stored value `
                     + "is not a Fyers access token" };
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(segments[1], "base64").toString("utf8"));
    } catch {
        return { ok: false, reason: "the JWT payload could not be decoded" };
    }
    if (!("hsm_key" in claims)) {
        return { ok: false,
                 reason: 'the token has no "hsm_key" claim, so the market-data '
                     + "socket cannot use it" };
    }
    if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) {
        return { ok: false, reason: "the token has expired" };
    }
    return { ok: true, reason: "well formed", claims: { exp: claims.exp ?? null } };
};

// Does FYERS accept it? Presence and shape are necessary and not sufficient: a
// token minted for a different app, or revoked, is well formed and refused.
//
// Uses the existing SDK instance rather than constructing a second client.
export const verifyWithFyers = async ({ fyers, token, clientId }) => {
    if (!fyers || !token) return { ok: false, reason: "no client or token to verify with" };
    try {
        if (clientId) fyers.setAppId(clientId);
        fyers.setAccessToken(token);
        const response = await fyers.get_profile();
        if (response?.s === "ok") return { ok: true, reason: "Fyers accepts it" };
        // Fyers' own wording is more useful than anything paraphrased.
        return { ok: false,
                 reason: `Fyers refused it: ${response?.message ?? response?.s ?? "unknown"}` };
    } catch (err) {
        return { ok: false, reason: `could not reach Fyers to verify: ${err.message}` };
    }
};

export const tokenSourceUrl = (env = process.env) => {
    for (const name of TOKEN_SOURCE_VARS) if (env[name]) return env[name];
    return null;
};

// True when the OAuth callback comes back to THIS machine, in which case
// nothing needs borrowing and the operator simply logs in.
export const mintsItsOwnToken = (redirectUri = process.env.FYERS_REDIRECT_URI) => {
    if (!redirectUri) return false;
    try {
        // URL.hostname keeps the brackets on an IPv6 literal, so [::1] would
        // not match a bare ::1 comparison.
        const host = new URL(redirectUri).hostname.replace(/^\[|\]$/g, "");
        return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
        return false;
    }
};

const liveToken = async (client) => {
    const [token, ttl] = await Promise.all([
        client.get(ACCESS_TOKEN_KEY),
        client.ttl(ACCESS_TOKEN_KEY),
    ]);
    return token && ttl > 0 ? { token, ttl } : null;
};

// Acquire a token for `redis` if it does not already have a live one.
//
// Returns a status and a message safe to print. Never throws: a failure to
// borrow a token is reported, not raised, because the caller decides whether
// that is fatal.
export const ensureFyersToken = async ({
    redis, env = process.env, logger = null, RedisClient = Redis,
    verify = false, fyers = null,
} = {}) => {
    // Presence, then shape, then — when asked — whether Fyers accepts it.
    // Reporting only the first of those is what let one process say "valid" and
    // another fail to authenticate with the same string.
    const settle = async (status, token, ttl) => {
        const shape = inspectToken(token);
        if (!shape.ok) return { status: STATUS.MALFORMED, message: shape.reason };

        const minutes = Math.round(ttl / 60);
        const life = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
        if (!verify) {
            return { status,
                     message: status === STATUS.SYNCED
                         ? `fetched from the token source, valid for ${life}`
                         : `valid for ${life}` };
        }
        const live = await verifyWithFyers({
            fyers, token, clientId: env.FYERS_CLIENT_ID });
        if (!live.ok) return { status: STATUS.REJECTED, message: live.reason };
        return { status,
                 message: status === STATUS.SYNCED
                     ? `fetched and accepted by Fyers, valid for ${life}`
                     : `accepted by Fyers, valid for ${life}` };
    };

    const existing = await liveToken(redis).catch(() => null);
    if (existing) return settle(STATUS.PRESENT, existing.token, existing.ttl);

    if (mintsItsOwnToken(env.FYERS_REDIRECT_URI)) {
        return { status: STATUS.LOCAL_MINT,
                 message: `no token; authenticate at ${env.FRONTEND_URL ?? ""}/reauth` };
    }

    const sourceUrl = tokenSourceUrl(env);
    if (!sourceUrl) {
        let callbackHost = "the hosted backend";
        try { callbackHost = new URL(env.FYERS_REDIRECT_URI).host; } catch { /* keep the generic */ }
        return {
            status: STATUS.NO_SOURCE,
            message: `no token here; the OAuth callback goes to ${callbackHost}, so the token `
                + `is in that deployment's Redis. Set ${TOKEN_SOURCE_VARS[0]} in apps/api/.env `
                + "to that Redis and startup will fetch it automatically",
        };
    }

    if (sourceUrl === env.REDIS_URL) {
        return { status: STATUS.SAME_REDIS,
                 message: `${TOKEN_SOURCE_VARS[0]} is the same Redis as REDIS_URL` };
    }

    const source = new RedisClient(sourceUrl, {
        lazyConnect: true, connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    try {
        await source.connect();
        const live = await liveToken(source);
        if (!live) {
            return { status: STATUS.SOURCE_EMPTY,
                     message: "the token source has no live token either; re-authenticate first" };
        }
        const expiry = await source.get(TOKEN_EXPIRY_KEY);

        // The real remaining TTL, so a borrowed token expires when the original
        // does rather than outliving it.
        await redis.set(ACCESS_TOKEN_KEY, live.token, "EX", live.ttl);
        if (expiry) await redis.set(TOKEN_EXPIRY_KEY, expiry);

        logger?.info?.("FyersToken", "token acquired from the configured source",
                       { validForMinutes: Math.round(live.ttl / 60) });
        return settle(STATUS.SYNCED, live.token, live.ttl);
    } catch (err) {
        // The message may name a host but never a credential: ioredis errors
        // carry the address, not the password.
        return { status: STATUS.FAILED,
                 message: `the token source could not be reached (${err.code ?? err.message})` };
    } finally {
        source.disconnect();
    }
};

export const acquired = (status) => status === STATUS.PRESENT || status === STATUS.SYNCED;
