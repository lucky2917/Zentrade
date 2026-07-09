const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const CRUMB_TTL_MS = 60 * 60 * 1000;

let cache = null;
let inFlight = null;

async function fetchCrumb() {
    const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YAHOO_UA } });
    const cookie = (cookieRes.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0])
        .join("; ");

    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
        headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    const crumb = await crumbRes.text();

    return { cookie, crumb, expiresAt: Date.now() + CRUMB_TTL_MS };
}

export async function getYahooCrumb() {
    if (cache && cache.expiresAt > Date.now()) {
        return cache;
    }

    if (!inFlight) {
        inFlight = fetchCrumb()
            .then((result) => {
                cache = result;
                return result;
            })
            .catch((err) => {
                // M3: Yahoo crumb endpoint is undocumented and breaks without notice.
                // Cache the failure briefly so we don't hammer a broken endpoint.
                cache = null;
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

export { YAHOO_UA };
