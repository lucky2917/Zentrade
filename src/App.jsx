import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { MarketProvider } from "./context/MarketContext.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Navbar from "./components/Navbar.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
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
  const { token } = useAuth();

  return (
    <>
      {token && <Navbar />}
      {token && <IndexTicker />}
      {token && <MarketStatusBanner />}
      <main className={token ? "main-content" : ""}>
        <Routes>
          <Route path="/login" element={token ? <Navigate to="/" replace /> : <Login />} />
          <Route path="/signup" element={token ? <Navigate to="/" replace /> : <Signup />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/stock/:symbol"
            element={
              <ProtectedRoute>
                <StockDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/portfolio"
            element={
              <ProtectedRoute>
                <Portfolio />
              </ProtectedRoute>
            }
          />
          <Route
            path="/watchlist"
            element={
              <ProtectedRoute>
                <Watchlist />
              </ProtectedRoute>
            }
          />
          <Route
            path="/orders"
            element={
              <ProtectedRoute>
                <Orders />
              </ProtectedRoute>
            }
          />
        </Routes>
      </main>
      {token && <MobileNav />}
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
 * or read live prices. when logged in it renders the navbar, index
 * ticker strip, market status banner, and mobile bottom tab bar.
 * routes include dashboard, stock detail, portfolio, watchlist,
 * and orders.
 */
