import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Sun, Moon, LogOut, Activity, Briefcase, ListOrdered, Wallet } from "lucide-react";

const Navbar = () => {
    const { user, logout } = useAuth();
    const { connected } = useMarket();
    const { theme, toggleTheme } = useTheme();
    const navigate = useNavigate();
    const location = useLocation();

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const formatBalance = (paise) => {
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(paise / 100);
    };

    return (
        <nav className="navbar">
            <div className="navbar-brand">
                <Link to="/" className="navbar-logo">
                    <span className="logo-zen">Zen</span>
                    <span className="logo-trade">Trade</span>
                </Link>
                <div className={`connection-status ${connected ? "connected" : "disconnected"}`}>
                    <span className="status-dot"></span>
                    {connected ? "Live" : "Offline"}
                </div>
            </div>

            <div className="navbar-links">
                <Link to="/" className={`nav-link ${location.pathname === "/" ? "active" : ""}`}>
                    <Activity size={16} /> Markets
                </Link>
                <Link to="/portfolio" className={`nav-link ${location.pathname === "/portfolio" ? "active" : ""}`}>
                    <Briefcase size={16} /> Portfolio
                </Link>
                <Link to="/orders" className={`nav-link ${location.pathname === "/orders" ? "active" : ""}`}>
                    <ListOrdered size={16} /> Orders
                </Link>
            </div>

            <div className="navbar-right">
                <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle Theme">
                    {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                </button>

                {user && (
                    <div className="navbar-balance">
                        <Wallet size={14} /> {formatBalance(user.balancePaise)}
                    </div>
                )}
                <button className="btn-logout" onClick={handleLogout} aria-label="Logout">
                    <LogOut size={16} /> <span>Logout</span>
                </button>
            </div>
        </nav>
    );
};

export default Navbar;

/*
 * the top navbar. shows the zentrade logo, live/offline connection
 * dot, nav links to markets/portfolio/orders, a sun/moon toggle
 * for theme switching, the user's wallet balance, and logout.
 * only renders when the user is logged in (App.jsx handles that).
 */
