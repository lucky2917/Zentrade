import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
);

/*
 * react entry point. renders the whole app inside StrictMode and
 * wraps everything in ThemeProvider so dark/light mode works
 * globally. this is what index.html points to via vite.
 */
