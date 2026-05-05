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
