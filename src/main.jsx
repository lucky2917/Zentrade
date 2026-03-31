import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import "./index.css";

const GOOGLE_CLIENT_ID = "739681231629-9gl01r7aunfsnrefvj224alh74ogi0c2.apps.googleusercontent.com";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
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
