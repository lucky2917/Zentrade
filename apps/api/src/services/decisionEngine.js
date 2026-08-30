import { spawn } from "node:child_process";
import { computeConsensus, applyDecisionGuardrails } from "./aiEngine.js";
import logger from "../utils/logger.js";

// Migration switch for the consensus + guardrails component.
//
//   typescript  (default) TypeScript decides. Go is not consulted.
//   shadow                TypeScript decides. Go runs alongside and any
//                         divergence is logged. Production behaviour is
//                         unchanged, which is what makes it safe to leave on.
//   go                    Go decides. Only legitimate after the cutover gate.
//
// Rollback is setting the variable back to "typescript"; no deploy of new code
// is required and the TypeScript implementation is never removed while this
// switch exists.

export const ENGINE_TYPESCRIPT = "typescript";
export const ENGINE_SHADOW = "shadow";
export const ENGINE_GO = "go";
const VALID_MODES = [ENGINE_TYPESCRIPT, ENGINE_SHADOW, ENGINE_GO];

export const engineMode = () => {
    const mode = (process.env.ZENTRADE_DECISION_ENGINE ?? ENGINE_TYPESCRIPT).toLowerCase();
    if (!VALID_MODES.includes(mode)) {
        logger.warn("DecisionEngine", `Unknown mode ${mode}, falling back to typescript`);
        return ENGINE_TYPESCRIPT;
    }
    return mode;
};

const divergences = [];
export const shadowDivergences = () => divergences.slice();
export const resetShadowDivergences = () => { divergences.length = 0; };

let client = null;

// A single long-lived daemon. Spawning per decision would cost milliseconds
// against nanoseconds of work.
const goClient = () => {
    if (client) return client;
    const binary = process.env.ZENTRADE_DECISIOND_PATH;
    if (!binary) return null;

    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let buffer = "";
    let nextId = 1;

    child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            try {
                const reply = JSON.parse(line);
                const resolve = pending.get(reply.id);
                if (resolve) { pending.delete(reply.id); resolve(reply); }
            } catch (err) {
                logger.error("DecisionEngine", "Malformed reply from decisiond", { error: err.message });
            }
        }
    });
    child.on("error", (err) => {
        logger.error("DecisionEngine", "decisiond failed", { error: err.message });
        client = null;
    });
    child.on("exit", () => { client = null; });

    client = {
        decide(request) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, resolve);
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("decisiond timeout"));
                }, 2000);
                const settle = (reply) => { clearTimeout(timer); resolve(reply); };
                pending.set(id, settle);
                child.stdin.write(JSON.stringify({ id, ...request }) + "\n");
            });
        },
        stop() { child.kill(); client = null; },
    };
    return client;
};

export const stopGoClient = () => { if (client) client.stop(); };

const decideTypeScript = ({ technical, sentiment, risk, score, action, confidence }) => {
    const consensus = computeConsensus(technical, sentiment, risk);
    const decided = applyDecisionGuardrails({ action, confidence }, consensus, score);
    return {
        direction: consensus.direction,
        bullish: consensus.bullish,
        bearish: consensus.bearish,
        neutral: consensus.neutral,
        label: consensus.label,
        impliedConfidence: consensus.impliedConfidence,
        finalAction: decided.action,
        finalConfidence: decided.confidence,
    };
};

const COMPARED_FIELDS = [
    "direction", "bullish", "bearish", "neutral",
    "label", "impliedConfidence", "finalAction", "finalConfidence",
];

export const diffResults = (ts, go) =>
    COMPARED_FIELDS
        .filter((field) => ts[field] !== go[field])
        .map((field) => ({ field, typescript: ts[field], go: go[field] }));

// The decision. TypeScript stays authoritative in every mode except "go", so
// a shadow failure can never change what the agent does.
export const decide = async (request) => {
    const mode = engineMode();
    const ts = decideTypeScript(request);
    if (mode === ENGINE_TYPESCRIPT) return ts;

    let go = null;
    try {
        const c = goClient();
        if (c) go = await c.decide(request);
    } catch (err) {
        logger.error("DecisionEngine", "Shadow comparison unavailable", { error: err.message });
    }

    if (!go) {
        if (mode === ENGINE_GO) {
            logger.error("DecisionEngine", "Go engine unavailable, using TypeScript");
        }
        return ts;
    }

    const differences = diffResults(ts, go);
    if (differences.length) {
        const record = { input: request, differences, at: new Date().toISOString() };
        divergences.push(record);
        logger.error("DecisionEngine", "PARITY DIVERGENCE — cutover blocked", record);
    }

    // Even in "go" mode a divergence falls back to TypeScript. Cutover is a
    // decision made against a clean parity run, not something the runtime
    // should improvise during one.
    if (mode === ENGINE_GO && !differences.length) {
        return {
            direction: go.direction,
            bullish: go.bullish,
            bearish: go.bearish,
            neutral: go.neutral,
            label: go.label,
            impliedConfidence: go.impliedConfidence,
            finalAction: go.finalAction,
            finalConfidence: go.finalConfidence,
        };
    }
    return ts;
};
