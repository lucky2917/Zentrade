import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Brain, Search } from "lucide-react";
import api from "../services/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import useGoogleAuth from "../hooks/useGoogleAuth.js";
import GoogleIcon from "../components/GoogleIcon.jsx";
import { formatPaise } from "../utils/format.js";

/** Journal browser (M10): read-only keyset paging over /api/decisions. */
const DecisionsList = () => {
    const [searchParams] = useSearchParams();
    const [rows, setRows] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState(searchParams.get("instrument") ?? "");
    const { user } = useAuth();
    const navigate = useNavigate();
    const handleGoogleAuth = useGoogleAuth();

    const fetchPage = useCallback(async (instrument, after) => {
        const params = new URLSearchParams();
        if (instrument) params.set("instrument", instrument.toUpperCase());
        if (after) params.set("cursor", after);
        params.set("limit", "20");
        const res = await api.get(`/decisions?${params}`);
        return res.data;
    }, []);

    const load = useCallback(async (instrument) => {
        setLoading(true);
        try {
            const page = await fetchPage(instrument, null);
            setRows(page.decisions);
            setCursor(page.nextCursor);
            setHasMore(page.hasMore);
        } catch { /* unauth or transient: handled by empty state below */ } finally {
            setLoading(false);
        }
    }, [fetchPage]);

    useEffect(() => { if (user) load(filter); else setLoading(false); }, [user, load]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadMore = async () => {
        const page = await fetchPage(filter, cursor);
        setRows((prev) => [...prev, ...page.decisions]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
    };

    if (!user) {
        return (
            <div className="empty-state glass-panel" style={{ marginTop: "2rem", maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>
                <Brain size={48} className="empty-icon" style={{ color: "var(--text-muted)" }} />
                <h2 style={{ marginBottom: "1rem" }}>Login Required</h2>
                <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>Sign in to browse the decision journal.</p>
                <button className="btn-login-google" style={{ margin: "0 auto" }} onClick={() => handleGoogleAuth()}>
                    <GoogleIcon size={16} style={{ marginRight: 6 }} /><span>Continue with Google</span>
                </button>
            </div>
        );
    }

    return (
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
            <div className="dashboard-header">
                <div>
                    <h1>Decisions</h1>
                    <p className="hero-subtitle">Every AI deliberation, exactly as journaled</p>
                </div>
                <div className="search-bar">
                    <Search size={16} className="search-icon" />
                    <input
                        type="text"
                        placeholder="Filter by symbol…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && load(filter)}
                    />
                </div>
            </div>

            {loading ? (
                <div className="loading-screen">Loading journal…</div>
            ) : rows.length === 0 ? (
                <div className="empty-state glass-panel"><h3>No journaled decisions{filter ? ` for ${filter.toUpperCase()}` : ""}</h3><p>Decisions appear here once the journal records AI runs.</p></div>
            ) : (
                <div className="stock-table-container">
                    <table className="stock-table">
                        <thead>
                            <tr><th>When</th><th>Symbol</th><th>Action</th><th>Mode</th><th>Confidence</th><th>Entry</th><th>Target</th><th>Stop</th></tr>
                        </thead>
                        <tbody>
                            {rows.map((d) => (
                                <tr key={d.decisionId} className="stock-row" onClick={() => navigate(`/decision/${d.decisionId}`)}>
                                    <td className="stock-name">{new Date(d.createdAt).toLocaleString("en-IN")}</td>
                                    <td className="stock-symbol">{d.instrument.symbol}</td>
                                    <td className={d.action === "BUY" ? "positive" : d.action === "SELL" ? "negative" : ""}>{d.action}</td>
                                    <td>{d.mode}</td>
                                    <td>{d.confidence}</td>
                                    <td className="stock-price">{d.entryMinor === null ? "—" : formatPaise(d.entryMinor)}</td>
                                    <td className="stock-price">{d.targetMinor === null ? "—" : formatPaise(d.targetMinor)}</td>
                                    <td className="stock-price">{d.stopMinor === null ? "—" : formatPaise(d.stopMinor)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {hasMore && (
                <button className="btn-primary" style={{ width: "auto", margin: "1.25rem auto" }} onClick={loadMore}>Load more</button>
            )}
        </motion.div>
    );
};

export default DecisionsList;
