import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldAlert, Clock } from "lucide-react";

const BACKEND_ORIGIN = (import.meta.env.VITE_API_URL || "/api").replace(/\/api\/?$/, "");

const Reauth = () => {
    const [searchParams] = useSearchParams();
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [remaining, setRemaining] = useState(null);

    const reauthSuccess = searchParams.get("reauth") === "success";
    const error = searchParams.get("error");

    const fetchStatus = async () => {
        try {
            const res = await axios.get(`${BACKEND_ORIGIN}/fyers/status`);
            setStatus(res.data);
        } catch (err) {
            console.error("Failed to fetch fyers status");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStatus();
    }, []);

    useEffect(() => {
        if (!status?.expiresAt) {
            setRemaining(null);
            return;
        }

        const tick = () => {
            const ms = status.expiresAt - Date.now();
            setRemaining(ms > 0 ? ms : 0);
        };

        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [status?.expiresAt]);

    const formatRemaining = (ms) => {
        if (ms == null) return "Unknown";
        if (ms <= 0) return "Expired";
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${hours}h ${minutes}m ${seconds}s`;
    };

    const isValid = remaining != null && remaining > 0;

    return (
        <motion.div
            className="reauth-page"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            <div className="dashboard-header">
                <h1><ShieldCheck size={28} className="mr-3 inline" style={{ color: 'var(--accent)' }} /> Fyers Re-authentication</h1>
            </div>

            {reauthSuccess && (
                <div className="glass-panel" style={{ marginTop: "1rem", padding: "1rem", color: 'var(--green)', border: '1px solid var(--green)' }}>
                    Re-authentication successful. Token is valid until 3:00 AM IST tomorrow.
                </div>
            )}

            {error && (
                <div className="glass-panel" style={{ marginTop: "1rem", padding: "1rem", color: 'var(--red)', border: '1px solid var(--red)' }}>
                    Re-authentication failed: {error}
                </div>
            )}

            <div className="empty-state glass-panel" style={{ marginTop: "2rem" }}>
                {loading ? (
                    <p>Checking token status...</p>
                ) : (
                    <>
                        {isValid ? (
                            <ShieldCheck size={48} className="mb-4" style={{ color: 'var(--green)' }} />
                        ) : (
                            <ShieldAlert size={48} className="mb-4" style={{ color: 'var(--red)' }} />
                        )}
                        <h2 style={{ marginBottom: "1rem" }}>{isValid ? "Token Active" : "Token Expired"}</h2>
                        <p style={{ color: 'var(--text-muted)', marginBottom: "1.5rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem" }}>
                            <Clock size={16} /> {formatRemaining(remaining)} remaining
                        </p>
                        <button
                            className="btn-primary"
                            onClick={() => { window.location.href = `${BACKEND_ORIGIN}/fyers/reauth`; }}
                        >
                            🔐 Login with Fyers
                        </button>
                    </>
                )}
            </div>
        </motion.div>
    );
};

export default Reauth;
