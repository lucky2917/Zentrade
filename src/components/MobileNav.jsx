import { Link, useLocation } from "react-router-dom";
import { Activity, Star, Briefcase, ListOrdered } from "lucide-react";

const NAV_ITEMS = [
    { path: "/", icon: Activity, label: "Markets" },
    { path: "/watchlist", icon: Star, label: "Watchlist" },
    { path: "/portfolio", icon: Briefcase, label: "Portfolio" },
    { path: "/orders", icon: ListOrdered, label: "Orders" },
];

const MobileNav = () => {
    const location = useLocation();

    return (
        <nav className="mobile-nav">
            {NAV_ITEMS.map(({ path, icon: Icon, label }) => (
                <Link
                    key={path}
                    to={path}
                    className={`mobile-nav-item ${location.pathname === path ? "active" : ""}`}
                >
                    <Icon size={20} />
                    <span>{label}</span>
                </Link>
            ))}
        </nav>
    );
};

export default MobileNav;

/*
 * bottom tab bar that only shows up on mobile screens (below 768px).
 * mirrors the navbar links that get hidden on small screens so mobile
 * users can still navigate between markets, watchlist, portfolio and
 * orders without any hamburger menu nonsense. fixed to the bottom
 * of the viewport like how most native trading apps do it.
 */
