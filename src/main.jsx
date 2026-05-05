import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </GoogleOAuthProvider>
  </StrictMode>
);

/*
 * react entry point. wraps the whole app in StrictMode, GoogleOAuthProvider
 * (for the continue with google button), and ThemeProvider for dark/light
 * mode. the google client id is public so its fine to have it here.
 * this is what index.html points to via vite.
 */
