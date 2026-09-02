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
const DecisionsList = lazy(() => import("./pages/DecisionsList.jsx"));
const DecisionDetail = lazy(() => import("./pages/DecisionDetail.jsx"));
const UsMarkets = lazy(() => import("./pages/UsMarkets.jsx"));
const UsStockDetail = lazy(() => import("./pages/UsStockDetail.jsx"));
const UsAgentActivity = lazy(() => import("./pages/UsAgentActivity.jsx"));

// The public architecture document. Rendered outside the trading shell and
// outside the auth and market providers: it is a reference document for
// reviewers, so it must not require a session or open a market connection.
const ArchitectureProgress = lazy(() => import("./pages/ArchitectureProgress.jsx"));

// The trader cockpit. Rendered outside the trading shell: it is a full-screen
// operator view of the autonomous system, and the shell's navbar, ticker and
// market banner would only compete with it. It is read-only and has no path to
// execution.
const TraderCockpit = lazy(() => import("./pages/TraderCockpit.jsx"));
const Logbook = lazy(() => import("./pages/Logbook.jsx"));

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
              <Route path="/decisions" element={<DecisionsList />} />
              <Route path="/decision/:id" element={<DecisionDetail />} />
              <Route path="/us-markets" element={<UsMarkets />} />
              <Route path="/us-stock/:symbol" element={<UsStockDetail />} />
              <Route path="/us-activity" element={<UsAgentActivity />} />
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
        <Routes>
          <Route
            path="/architecture-progress"
            element={
              <ErrorBoundary>
                <Suspense fallback={<div className="loading-screen">Loading...</div>}>
                  <ArchitectureProgress />
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/logs"
            element={
              <ErrorBoundary>
                <Suspense fallback={<div className="loading-screen">Loading...</div>}>
                  <AuthProvider>
                    <Logbook />
                  </AuthProvider>
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/trader"
            element={
              <ErrorBoundary>
                <Suspense fallback={<div className="loading-screen">Loading...</div>}>
                  <AuthProvider>
                    <TraderCockpit />
                  </AuthProvider>
                </Suspense>
              </ErrorBoundary>
            }
          />
          <Route
            path="/*"
            element={
              <AuthProvider>
                <MarketProvider>
                  <AppContent />
                </MarketProvider>
              </AuthProvider>
            }
          />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
};

export default App;
