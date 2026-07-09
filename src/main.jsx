import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import * as Sentry from "@sentry/react";
import App from "./App.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import "./index.css";

// Error monitoring — no-op unless a DSN is configured at build time
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    // errors only — no performance tracing, no session replay
    tracesSampleRate: 0,
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </GoogleOAuthProvider>
  </StrictMode>
);

