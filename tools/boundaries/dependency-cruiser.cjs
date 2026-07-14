/**
 * Architectural boundary rules — enforced in CI (npm run check:boundaries).
 *
 * M1 baseline (constitution: docs/architecture/adr/0001-monorepo-skeleton.md):
 *   - apps must never import from each other
 *   - packages must never import from apps
 * Later milestones append rules here (e.g. domain packages may only import
 * kernel + contracts) — rules are added, existing ones never relaxed.
 */
module.exports = {
    forbidden: [
        {
            name: "no-app-to-app",
            comment: "apps are independently deployable; they may only share code via packages/*",
            severity: "error",
            from: { path: "^apps/([^/]+)/" },
            to: { path: "^apps/(?!$1)[^/]+/" },
        },
        {
            name: "no-package-to-app",
            comment: "packages are the reusable layer; depending on an app inverts the architecture",
            severity: "error",
            from: { path: "^packages/" },
            to: { path: "^apps/" },
        },
        {
            // M4: contracts is the spine — it may import zod and nothing else
            name: "contracts-stays-pure",
            comment: "contracts imports no other workspace package",
            severity: "error",
            from: { path: "^packages/contracts/" },
            to: { path: "^packages/(?!contracts)" },
        },
        {
            // M4: kernel has zero runtime dependencies, including workspaces
            name: "kernel-stays-pure",
            comment: "kernel imports no other workspace package",
            severity: "error",
            from: { path: "^packages/kernel/" },
            to: { path: "^packages/(?!kernel)" },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        exclude: { path: "\\.(test|spec)\\.js$|__tests__|/dist/|/dev-dist/" },
        tsPreCompilationDeps: false,
        enhancedResolveOptions: {
            exportsFields: ["exports"],
            conditionNames: ["import", "require", "node", "default"],
        },
    },
};
