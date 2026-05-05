import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { Sun, Moon, LogOut, Activity, Briefcase, ListOrdered, Wallet, Star } from "lucide-react";
import { useToast } from "../context/ToastContext.jsx";

const Navbar = () => {
    const { user, token, logout, googleLogin } = useAuth();
    const { connected } = useMarket();
    const { theme, toggleTheme } = useTheme();
    const navigate = useNavigate();
    const location = useLocation();
    const { addToast } = useToast();

    const handleLogout = () => {
        logout();
        navigate("/");
        addToast("Logged out successfully", "success");
    };

    const handleGoogleAuth = useGoogleLogin({
        flow: "implicit",
        onSuccess: async (tokenResponse) => {
            try {
                await googleLogin(tokenResponse.access_token);
                addToast("Logged in successfully", "success");
            } catch (err) {
                addToast(err.response?.data?.error || "Login failed", "error");
            }
        },
        onError: () => {
            addToast("Login cancelled", "error");
        },
    });

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

                {token && user ? (
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
                        <svg viewBox="0 0 24 24" width="16" height="16" style={{ marginRight: '6px' }}>
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        <span>Login</span>
                    </button>
                )}
            </div>
        </nav>
    );
};

export default Navbar;
