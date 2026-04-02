import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { MarketProvider } from "./context/MarketContext.jsx";
import Navbar from "./components/Navbar.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import StockDetail from "./pages/StockDetail.jsx";
import Portfolio from "./pages/Portfolio.jsx";
import Orders from "./pages/Orders.jsx";
import Watchlist from "./pages/Watchlist.jsx";
import IndexTicker from "./components/IndexTicker.jsx";
import MarketStatusBanner from "./components/MarketStatusBanner.jsx";
import MobileNav from "./components/MobileNav.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";

const AppContent = () => {
  return (
    <>
      <Navbar />
      <IndexTicker />
      <MarketStatusBanner />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/stock/:symbol" element={<StockDetail />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/orders" element={<Orders />} />
        </Routes>
      </main>
      <MobileNav />
    </>
  );
};

const App = () => {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <MarketProvider>
            <AppContent />
          </MarketProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
};

export default App;

/*
 * root component that wires up the whole app. wraps everything in
 * toast, auth, and market providers so any child can fire toasts
 * or read live prices. the navbar, ticker, and routing are now globally
 * available whether authenticated or not. public routes include the dashboard
 * and stock detail pages.
 */
