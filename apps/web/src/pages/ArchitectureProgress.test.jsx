import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ArchitectureProgress from "./ArchitectureProgress.jsx";

// The public architecture document. It must render with no session, no market
// connection and no network access at all, because reviewers open it directly.

describe("ArchitectureProgress", () => {
    afterEach(cleanup);

    it("renders without any provider, router or authenticated session", () => {
        render(<ArchitectureProgress />);
        expect(screen.getByRole("heading", { level: 1 }).textContent)
            .toBe("ZenTrade Brain — Architecture & Progress");
    });

    it("sets the document title and description", () => {
        render(<ArchitectureProgress />);
        expect(document.title).toBe("ZenTrade Brain — Architecture & Progress");
        expect(document.querySelector('meta[name="description"]').getAttribute("content"))
            .toMatch(/senior-trader-style autonomous trading system/);
    });

    it("identifies itself as the official architecture document", () => {
        render(<ArchitectureProgress />);
        expect(screen.getByText("Official architecture document")).toBeDefined();
    });

    it("renders all thirteen parts", () => {
        const { container } = render(<ArchitectureProgress />);
        expect(container.querySelectorAll(".ap-part")).toHaveLength(13);
        for (let i = 1; i <= 13; i += 1) {
            expect(container.querySelector(`#p${i}`)).not.toBeNull();
        }
    });

    it("renders the six-tier architecture with the reflex tier first", () => {
        const { container } = render(<ArchitectureProgress />);
        const tiers = container.querySelectorAll("#p2 .ap-tier-id");
        expect(tiers[0].textContent).toBe("TIER 0");
        expect([...tiers].map((t) => t.textContent)).toContain("TIER 5");
    });

    it("states the headline progress figure and its two lowest categories", () => {
        const { container } = render(<ArchitectureProgress />);
        expect(container.querySelector(".ap-big").textContent).toBe("45%");
        const labels = [...container.querySelectorAll(".ap-bar-lbl")].map((n) => n.textContent);
        expect(labels).toContain("Live operation");
        expect(labels).toContain("Demonstrated edge");
    });

    it("does not claim live operation anywhere", () => {
        const { container } = render(<ArchitectureProgress />);
        const text = container.textContent;
        expect(text).toMatch(/Paper mode only/);
        expect(text).toMatch(/never processed a tick from a live market session/);
        expect(text).not.toMatch(/currently trading live|is live trading/i);
    });

    it("leaks no internal hosting, tooling or environment detail", () => {
        const { container } = render(<ArchitectureProgress />);
        const text = container.textContent;
        for (const forbidden of [
            "onrender.com", "localhost", "postgresql://", "redis://",
            "process.env", "ZENTRADE_", "/Users/", "vercel",
        ]) {
            expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
    });

    it("restores the previous document title when unmounted", () => {
        document.title = "Zentrade";
        const view = render(<ArchitectureProgress />);
        expect(document.title).toBe("ZenTrade Brain — Architecture & Progress");
        view.unmount();
        expect(document.title).toBe("Zentrade");
    });
});
