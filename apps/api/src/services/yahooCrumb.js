const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const CRUMB_TTL_MS = 60 * 60 * 1000;
// Yahoo regularly rejects datacenter IPs — back off instead of hammering
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

let cache = null;
let inFlight = null;
let failedUntil = 0;

// Real crumbs are short opaque tokens; an HTML/JSON error page is not one
const looksLikeCrumb = (c) =>
    typeof c === "string" && c.length > 0 && c.length <= 32 && !/[<>{}\s]/.test(c);

async function fetchCrumb() {
    const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YAHOO_UA } });
    const cookie = (cookieRes.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0])
        .join("; ");
    if (!cookie) throw new Error("Yahoo did not set a session cookie");

    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
        headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    const crumb = await crumbRes.text();
    // Never cache a bad crumb — that poisons every request for the TTL window
    if (!crumbRes.ok || !looksLikeCrumb(crumb)) {
        throw new Error(`Yahoo crumb rejected (status ${crumbRes.status})`);
    }

    return { cookie, crumb, expiresAt: Date.now() + CRUMB_TTL_MS };
}

export async function getYahooCrumb() {
    if (cache && cache.expiresAt > Date.now()) {
        return cache;
    }

    if (Date.now() < failedUntil) {
        throw new Error("Yahoo crumb unavailable, cooling down after failure");
    }

    if (!inFlight) {
        inFlight = fetchCrumb()
            .then((result) => {
                cache = result;
                failedUntil = 0;
                return result;
            })
            .catch((err) => {
                // M3: Yahoo crumb endpoint is undocumented and breaks without notice.
                // Cache the failure so we don't hammer a broken/blocking endpoint.
                cache = null;
                failedUntil = Date.now() + FAIL_COOLDOWN_MS;
                throw err;
            })
            .finally(() => {
                inFlight = null;
            });
    }

    return inFlight;
}

// Call when Yahoo answers 401 "Invalid Crumb" — the cached crumb outlived
// its cookie session, so the next getYahooCrumb() fetches a fresh pair
export function invalidateYahooCrumb() {
    cache = null;
}

// Call when even a freshly fetched crumb gets a 401 — Yahoo is rejecting
// this server's IP, so stop trying (and stop logging) for the cooldown
export function startYahooCooldown() {
    cache = null;
    failedUntil = Date.now() + FAIL_COOLDOWN_MS;
}

export { YAHOO_UA };
