import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, ShieldCheck, DollarSign, Hash } from "lucide-react";
import api from "../services/api.js";

const fmt = (n) =>
    n != null
        ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n)
        : "—";

const RiskManager = ({ entry, stopLoss, action }) => {
    const [riskPct, setRiskPct]         = useState(1.0);
    const [walletPaise, setWalletPaise] = useState(null);
    const [loading, setLoading]         = useState(true);

    useEffect(() => {
        api.get("/portfolio")
            .then((r) => setWalletPaise(r.data?.balancePaise ?? null))
            .catch(() => setWalletPaise(null))
            .finally(() => setLoading(false));
    }, []);

    const calc = useMemo(() => {
        if (!walletPaise || !entry || !stopLoss || entry <= 0 || stopLoss <= 0) return null;

        const wallet       = walletPaise / 100;           // paise → ₹
        const riskPerShare = Math.abs(entry - stopLoss);
        const maxRisk      = wallet * (riskPct / 100);
        const maxQty       = riskPerShare > 0 ? Math.floor(maxRisk / riskPerShare) : 0;
        const totalCost    = maxQty * entry;
        const canAfford    = totalCost <= wallet;
        const actualQty    = canAfford ? maxQty : Math.floor(wallet / entry);
        const actualCost   = actualQty * entry;
        const actualRisk   = actualQty * riskPerShare;
        const actualRiskPct = wallet > 0 ? (actualRisk / wallet) * 100 : 0;

        return {
            wallet,
            riskPerShare,
            maxRisk,
            maxQty,
            actualQty,
            actualCost,
            actualRisk,
            actualRiskPct,
            canAfford,
            isHighRisk: riskPct >= 2.5,
            isOverBudget: !canAfford && maxQty > 0,
        };
    }, [walletPaise, entry, stopLoss, riskPct]);

    if (!entry || !stopLoss) return null;
    if (loading) return null;
    if (!walletPaise || walletPaise <= 0) return null;

    const isWarn = calc?.isHighRisk || calc?.isOverBudget;
    const accentColor = isWarn ? "#ef4444" : "#10b981";

    return (
        <div style={{
            background: `${accentColor}08`,
            border: `1px solid ${accentColor}25`,
            borderRadius: 10,
            padding: "0.9rem 1rem",
            marginTop: "0.85rem",
        }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: "0.75rem" }}>
                {isWarn
                    ? <AlertTriangle size={13} style={{ color: accentColor }} />
                    : <ShieldCheck   size={13} style={{ color: accentColor }} />}
                <span style={{ fontSize: "0.78rem", fontWeight: 700, color: accentColor }}>
                    Position Sizer
                </span>
                <span style={{ marginLeft: "auto", fontSize: "0.68rem", color: "#64748b" }}>
                    Wallet: {fmt(calc?.wallet ?? walletPaise / 100)}
                </span>
            </div>

            {/* Risk slider */}
            <div style={{ marginBottom: "0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Risk per trade</span>
                    <span style={{
                        fontSize: "0.75rem", fontWeight: 700,
                        color: riskPct >= 2.5 ? "#ef4444" : riskPct >= 1.5 ? "#f59e0b" : "#10b981",
                    }}>
                        {riskPct.toFixed(1)}% of account
                    </span>
                </div>
                <input
                    type="range"
                    min={0.25} max={5} step={0.25}
                    value={riskPct}
                    onChange={(e) => setRiskPct(Number(e.target.value))}
                    style={{
                        width: "100%", accentColor,
                        cursor: "pointer", height: 4,
                    }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.6rem", color: "#475569", marginTop: 2 }}>
                    <span>0.25%</span>
                    <span style={{ color: "#10b981" }}>1% safe</span>
                    <span style={{ color: "#f59e0b" }}>2% moderate</span>
                    <span style={{ color: "#ef4444" }}>5% danger</span>
                </div>
            </div>

            {/* Stats grid */}
            {calc && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.45rem", marginBottom: "0.55rem" }}>
                    <Stat icon={DollarSign} label="Risk amount"    value={fmt(calc.maxRisk)}      color="#94a3b8" />
                    <Stat icon={Hash}       label="Max quantity"   value={`${calc.actualQty} sh`}  color="#94a3b8" />
                    <Stat icon={DollarSign} label="Capital needed" value={fmt(calc.actualCost)}   color="#94a3b8" />
                    <Stat icon={DollarSign} label="Actual risk"    value={fmt(calc.actualRisk)}   color={calc.isHighRisk ? "#ef4444" : "#94a3b8"} />
                </div>
            )}

            {/* Warnings */}
            {calc?.isHighRisk && (
                <Warning>
                    Risking {riskPct}% per trade. Most pros cap single-trade risk at 1–2%. Are you sure?
                </Warning>
            )}
            {calc?.isOverBudget && (
                <Warning>
                    Full position ({fmt(calc.maxQty * entry)}) exceeds wallet. Quantity capped to {calc.actualQty} shares.
                </Warning>
            )}

            {/* Stop-loss context */}
            {calc && calc.actualQty > 0 && (
                <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: 4, textAlign: "center" }}>
                    {calc.actualQty} × ₹{entry} entry → stop at ₹{stopLoss} → loss ≤ {fmt(calc.actualRisk)} ({calc.actualRiskPct.toFixed(2)}% of wallet)
                </div>
            )}
        </div>
    );
};

function Stat({ icon: Icon, label, value, color }) {
    return (
        <div style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 7, padding: "0.4rem 0.55rem",
            display: "flex", flexDirection: "column", gap: 2,
        }}>
            <div style={{ fontSize: "0.62rem", color: "#64748b", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon size={9} /> {label}
            </div>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color }}>{value}</div>
        </div>
    );
}

function Warning({ children }) {
    return (
        <div style={{
            display: "flex", alignItems: "flex-start", gap: 6,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 6, padding: "0.35rem 0.5rem",
            marginTop: "0.4rem",
        }}>
            <AlertTriangle size={11} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: "0.68rem", color: "#fca5a5", lineHeight: 1.45 }}>{children}</span>
        </div>
    );
}

export default RiskManager;
