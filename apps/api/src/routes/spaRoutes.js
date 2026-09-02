// Client-side routes the API must answer with the app shell.
//
// The web app owns these paths, but a direct visit or a refresh reaches the API
// first. A route missing from this list returns 404, which reads as a page that
// does not exist rather than as a missing line in a list, so the list is kept
// in one place and asserted by a test.
export const SPA_ROUTES = ["/trader", "/logs", "/architecture-progress"];
