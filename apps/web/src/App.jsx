import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { MarketProvider } from "./context/MarketContext.jsx";
import Navbar from "./components/Navbar.jsx";
import IndexTicker from "./components/IndexTicker.jsx";
import MarketStatusBanner from "./components/MarketStatusBanner.jsx";
import MobileNav from "./components/MobileNav.jsx";
import PWAInstallPrompt from "./components/PWAInstallPrompt.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";

const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const StockDetail = lazy(() => import("./pages/StockDetail.jsx"));
const Portfolio = lazy(() => import("./pages/Portfolio.jsx"));
const Orders = lazy(() => import("./pages/Orders.jsx"));
const Watchlist = lazy(() => import("./pages/Watchlist.jsx"));
const Reauth = lazy(() => import("./pages/Reauth.jsx"));
const Login = lazy(() => import("./pages/Login.jsx"));

const AppContent = () => {
  return (
    <>
      <Navbar />
      <IndexTicker />
      <MarketStatusBanner />
      <main className="main-content">
        <ErrorBoundary>
          <Suspense fallback={<div className="loading-screen">Loading...</div>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/stock/:symbol" element={<StockDetail />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/watchlist" element={<Watchlist />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/reauth" element={<Reauth />} />
              <Route path="/login" element={<Login />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <MobileNav />
      <PWAInstallPrompt />
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
