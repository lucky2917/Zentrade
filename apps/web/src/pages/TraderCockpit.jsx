import { useState } from "react";
import useCockpit from "../hooks/useCockpit.js";
import { StatusBar, StandbyBanner } from "../components/cockpit/StatusBar.jsx";
import ReasoningStream from "../components/cockpit/ReasoningStream.jsx";
import { CurrentThought, MarketWorld, Positions, OrderLifecycle, EventStream,
         SystemHealth, DecisionCards, Account, DecisionHistory }
    from "../components/cockpit/Panels.jsx";
import "./TraderCockpit.css";

// The AI trader cockpit.
//
// Read only, completely. There is no control on this page that can place an
// order, change risk, alter a thesis or disable a safety check, and there is no
// endpoint behind it that could. It observes a system that is already running.
//
// It also never manufactures activity. Every block on the screen is rendered
// from an event the runtime actually emitted; when the market is quiet the
// screen is quiet, and says so.

const TraderCockpit = () => {
    const { snapshot, events, connected, error } = useCockpit();
    const [showObservations, setShowObservations] = useState(false);

    if (error && !snapshot) {
        return (
            <div className="ck-root ck-centered">
                <div className="ck-empty">
                    <h1>ZENTRADE AI TRADER</h1>
                    <p>{error}</p>
                </div>
            </div>
        );
    }

    if (!snapshot) {
        return (
            <div className="ck-root ck-centered">
                <div className="ck-empty">
                    <h1>ZENTRADE AI TRADER</h1>
                    <p className="ck-muted">connecting to the runtime…</p>
                </div>
            </div>
        );
    }

    return (
        <div className="ck-root">
            <StatusBar snapshot={snapshot} events={events} connected={connected} />
            <StandbyBanner snapshot={snapshot} events={events} />

            <div className="ck-layout">
                <aside className="ck-col ck-col-left">
                    <Account account={snapshot.account} />
                    <CurrentThought narration={snapshot.narration} />
                    <MarketWorld world={snapshot.world} />
                    <SystemHealth snapshot={snapshot} />
                </aside>

                <main className="ck-col ck-col-main">
                    <div className="ck-main-head">
                        <h2>Senior trader · live reasoning</h2>
                        <label className="ck-toggle">
                            <input type="checkbox" checked={showObservations}
                                   onChange={(e) => setShowObservations(e.target.checked)} />
                            show quiet observation passes
                        </label>
                    </div>
                    <ReasoningStream events={events} showObservations={showObservations} />
                </main>

                <aside className="ck-col ck-col-right">
                    <Positions positions={snapshot.positions} />
                    <OrderLifecycle openOrders={snapshot.openOrders}
                                    todaysOrders={snapshot.todaysOrders} />
                    <EventStream events={events} />
                    <DecisionCards cards={snapshot.narration?.decisionCards} />
                    <DecisionHistory />
                </aside>
            </div>

            <footer className="ck-footer">
                Paper simulation. No order-placement code exists in this system;
                the safety boundary is absence, not a setting. This view is
                read-only and cannot act on the market.
            </footer>
        </div>
    );
};

export default TraderCockpit;
