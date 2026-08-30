import { describe, expect, it } from "vitest";
import {
    STATES, VALID_TRANSITIONS, TERMINAL_STATES, canTransition, assertTransition,
    isTerminal, stateAfterFill, InvalidTransition,
} from "../services/execution/states.js";

const ALL = Object.values(STATES);

describe("the transition table is the authority", () => {
    it("covers every state", () => {
        for (const s of ALL) expect(VALID_TRANSITIONS[s]).toBeDefined();
    });

    it("SUBMISSION IS NOT EXECUTION: NEW cannot become FILLED", () => {
        expect(canTransition(STATES.NEW, STATES.FILLED)).toBe(false);
        expect(() => assertTransition(STATES.NEW, STATES.FILLED)).toThrow(InvalidTransition);
    });

    it("NEW cannot skip to WORKING or PARTIALLY_FILLED", () => {
        expect(canTransition(STATES.NEW, STATES.WORKING)).toBe(false);
        expect(canTransition(STATES.NEW, STATES.PARTIALLY_FILLED)).toBe(false);
    });

    it("ACCEPTED cannot fill without first working", () => {
        expect(canTransition(STATES.ACCEPTED, STATES.FILLED)).toBe(false);
        expect(canTransition(STATES.ACCEPTED, STATES.PARTIALLY_FILLED)).toBe(false);
    });

    it("terminal states have no outgoing edges", () => {
        for (const s of TERMINAL_STATES) expect(VALID_TRANSITIONS[s].size).toBe(0);
    });

    it("AMBIGUOUS is not terminal — reconciliation must be able to resolve it", () => {
        expect(isTerminal(STATES.AMBIGUOUS)).toBe(false);
        expect(VALID_TRANSITIONS[STATES.AMBIGUOUS].size).toBeGreaterThan(0);
    });

    it("every state can reach AMBIGUOUS except terminals", () => {
        for (const s of ALL) {
            if (isTerminal(s) || s === STATES.AMBIGUOUS) continue;
            expect(canTransition(s, STATES.AMBIGUOUS)).toBe(true);
        }
    });

    it("REJECTED belongs to submission time only", () => {
        expect(canTransition(STATES.NEW, STATES.REJECTED)).toBe(true);
        expect(canTransition(STATES.WORKING, STATES.REJECTED)).toBe(false);
        expect(canTransition(STATES.PARTIALLY_FILLED, STATES.REJECTED)).toBe(false);
    });

    it("a partially filled order may keep filling", () => {
        expect(canTransition(STATES.PARTIALLY_FILLED, STATES.PARTIALLY_FILLED)).toBe(true);
        expect(canTransition(STATES.PARTIALLY_FILLED, STATES.FILLED)).toBe(true);
    });

    it("a partially filled order may still be cancelled or expire", () => {
        expect(canTransition(STATES.PARTIALLY_FILLED, STATES.CANCELLED)).toBe(true);
        expect(canTransition(STATES.PARTIALLY_FILLED, STATES.EXPIRED)).toBe(true);
    });

    it("rejects every transition not in the table", () => {
        let illegal = 0;
        for (const from of ALL) for (const to of ALL) {
            if (canTransition(from, to)) continue;
            expect(() => assertTransition(from, to)).toThrow(InvalidTransition);
            illegal += 1;
        }
        expect(illegal).toBeGreaterThan(40);
    });
});

describe("state after fill", () => {
    it("is FILLED only at the full requested quantity", () => {
        expect(stateAfterFill(100, 100)).toBe(STATES.FILLED);
        expect(stateAfterFill(100, 99)).toBe(STATES.PARTIALLY_FILLED);
        expect(stateAfterFill(100, 1)).toBe(STATES.PARTIALLY_FILLED);
    });
    it("stays WORKING at zero filled", () => {
        expect(stateAfterFill(100, 0)).toBe(STATES.WORKING);
    });
    it("refuses an overfill rather than clamping it", () => {
        expect(() => stateAfterFill(100, 101)).toThrow(/overfill/);
    });
});
