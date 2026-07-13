import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import useGoogleAuth from "../hooks/useGoogleAuth.js";
import GoogleIcon from "./GoogleIcon.jsx";
import { formatPaise } from "../utils/format.js";
import { Sun, Moon, LogOut, Activity, Briefcase, ListOrdered, Wallet, Star } from "lucide-react";
import { useToast } from "../context/ToastContext.jsx";

const Navbar = () => {
    const { user, logout } = useAuth();
    const { connected } = useMarket();
    const { theme, toggleTheme } = useTheme();
    const navigate = useNavigate();
    const location = useLocation();
    const { addToast } = useToast();

    const handleLogout = async () => {
        await logout();
        navigate("/");
        addToast("Logged out successfully", "success");
    };

    const handleGoogleAuth = useGoogleAuth();

    const formatBalance = formatPaise;

    return (
        <nav className="navbar">
            <div className="navbar-brand">
                <Link to="/" className="navbar-logo">
                    <span className="logo-z">Z</span>
                    <span className="logo-name">entrade</span>
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
                <Link to="/watchlist" className={`nav-link ${location.pathname === "/watchlist" ? "active" : ""}`}>
                    <Star size={16} /> Watchlist
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

                {user ? (
                    <>
                        <div className="navbar-user-info">
                            {user.name && <span className="navbar-username">{user.name}</span>}
                            <div className="navbar-balance">
                                <Wallet size={14} /> {formatBalance(user.balancePaise)}
                            </div>
                        </div>
                        <button className="btn-logout" onClick={handleLogout} aria-label="Logout">
                            <LogOut size={16} /> <span className="hide-mobile">Logout</span>
                        </button>
                    </>
                ) : (
                    <button className="btn-login-google" onClick={() => handleGoogleAuth()} aria-label="Login">
                        <GoogleIcon size={16} style={{ marginRight: '6px' }} />
                        <span>Login</span>
                    </button>
                )}
            </div>
        </nav>
    );
};

export default Navbar;
