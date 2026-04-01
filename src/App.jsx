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

const AppContent = () => {
  const { token } = useAuth();

  return (
    <>
      {token && <Navbar />}
      {token && <IndexTicker />}
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
    </>
  );
};

const App = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <MarketProvider>
          <AppContent />
        </MarketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
};

export default App;

/*
 * root component. sets up react router and wraps everything in
 * auth + market providers. all the page routes are defined here —
 * login, signup, dashboard, stock detail, portfolio, orders.
 * if user is logged in it shows the navbar, otherwise redirects
 * to login.
 */
