import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SPA_ROUTES } from "../routes/spaRoutes.js";

// A page the web app serves outside its authenticated shell is reached through
// the API on a direct visit or a refresh. If the API does not know the path it
// answers 404 and the page looks missing, so the two lists have to agree.

const appJsx = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../web/src/App.jsx"), "utf8");

describe("single page routes", () => {
    // Routes declared in the outer <Routes>, which is everything that is not
    // the catch-all authenticated shell.
    const declared = [...appJsx.matchAll(/path="(\/[a-z0-9-]+)"/g)]
        .map((m) => m[1]);

    it("serves the app shell for every standalone page", () => {
        const standalone = ["/trader", "/logs", "/architecture-progress"];
        for (const route of standalone) {
            expect(declared, `${route} is no longer declared in App.jsx`).toContain(route);
            expect(SPA_ROUTES, `${route} would 404 on refresh`).toContain(route);
        }
    });

    it("lists no route the app does not declare", () => {
        for (const route of SPA_ROUTES) expect(declared).toContain(route);
    });

    it("keeps the logbook reachable", () => {
        expect(SPA_ROUTES).toContain("/logs");
    });
});
