import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useMarket } from "../context/MarketContext.jsx";

const Navbar = () => {
    const { user, logout } = useAuth();
    const { connected } = useMarket();
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
                    Markets
                </Link>
                <Link to="/portfolio" className={`nav-link ${location.pathname === "/portfolio" ? "active" : ""}`}>
                    Portfolio
                </Link>
                <Link to="/orders" className={`nav-link ${location.pathname === "/orders" ? "active" : ""}`}>
                    Orders
                </Link>
            </div>
            <div className="navbar-right">
                {user && (
                    <div className="navbar-balance">
                        {formatBalance(user.balancePaise)}
                    </div>
                )}
                <button className="btn-logout" onClick={handleLogout}>
                    Logout
                </button>
            </div>
        </nav>
    );
};

export default Navbar;
