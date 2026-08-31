import { readTick } from "../autonomous/positionState.js";
import { toPaise } from "../../utils/paise.js";
import {
    ensureAccount, accountState, recordAgentEvent, writeSessionSummary, sessionDateOf,
    reconcileAccount,
} from "./paperAccount.js";

// The account's lifecycle around one process run.
//
// Opening the account, keeping the day's summary current, and recording that
// the agent started and stopped. Separate from paperAccount.js because that
// module is pure persistence with an injected clock and price source, while
// this one owns the timer and the Redis price reads.

const SUMMARY_INTERVAL_MS = 60_000;

// The last traded price we hold for a symbol, in paise. Null rather than zero
// when there is no tick: an unpriced position must not value itself at nothing.
export const lastPricePaise = async (symbol) => {
    const tick = await readTick(symbol);
    return Number.isFinite(tick?.price) ? toPaise(tick.price) : null;
};

export const openAccountSession = async ({
    userId, logger = null, priceFor = lastPricePaise,
    intervalMs = SUMMARY_INTERVAL_MS, clock = () => new Date(), pid = process.pid,
}) => {
    const account = await ensureAccount({ userId });
    const opening = await accountState({ userId, priceFor });

    if (account.opened) {
        logger?.info?.("Account", "paper account opened", {
            startingCapitalPaise: Number(account.starting_capital_paise) });
    }

    // Checked before anything trades. A drifted ledger is reported, never
    // repaired: the balance is the record, and a startup that quietly rewrites
    // it to match its own arithmetic hides the bug that caused the drift.
    const reconciliation = await reconcileAccount({ userId });
    if (!reconciliation.ok) {
        logger?.error?.("Account", "account did not reconcile on startup", {
            driftPaise: reconciliation.driftPaise,
            failed: reconciliation.checks.filter((c) => !c.ok).map((c) => c.name),
        });
        await recordAgentEvent({ userId, kind: "RECONCILIATION_FAILED", at: clock(),
                                 detail: reconciliation });
    }

    // Recorded before anything trades, so the state the process resumed from is
    // in the record even if the process then dies. This is the line that shows
    // a restart continued rather than reset.
    await recordAgentEvent({ userId, kind: "AGENT_START", at: clock(), detail: {
        pid,
        openedAccount: account.opened,
        startingCapitalPaise: Number(account.starting_capital_paise),
        cashPaise: opening?.cashPaise ?? null,
        equityPaise: opening?.equityPaise ?? null,
        realisedPnlPaise: opening?.realisedPnlPaise ?? null,
        unrealisedPnlPaise: opening?.unrealisedPnlPaise ?? null,
        recoveredPositions: opening?.positions?.map((p) => ({
            symbol: p.symbol, quantity: p.quantity, avgPricePaise: p.avgPricePaise })) ?? [],
        reconciled: reconciliation.ok,
    }});

    const write = async () => {
        try {
            const state = await accountState({ userId, priceFor });
            if (state) await writeSessionSummary({ userId, state, at: clock() });
        } catch (err) {
            logger?.warn?.("Account", "session summary not written", { error: err.message });
        }
    };
    await write();

    const timer = setInterval(write, intervalMs);
    timer.unref?.();

    return {
        account,
        opening,
        reconciliation,
        sessionDate: sessionDateOf(clock()),
        state: () => accountState({ userId, priceFor }),
        // Flushes the day before the process goes away, so an orderly stop
        // leaves the same record a crash would have left a minute later.
        close: async (reason = "shutdown") => {
            clearInterval(timer);
            await write();
            const state = await accountState({ userId, priceFor }).catch(() => null);
            await recordAgentEvent({ userId, kind: "AGENT_STOP", at: clock(), detail: {
                pid, reason,
                cashPaise: state?.cashPaise ?? null,
                equityPaise: state?.equityPaise ?? null,
                openPositions: state?.positions?.length ?? 0,
            }}).catch(() => {});
        },
    };
};
