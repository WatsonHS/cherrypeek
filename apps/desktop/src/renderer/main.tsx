import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

// Follow the system appearance; docs/DESIGN.md keys dark tokens off data-theme.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = darkQuery.matches ? "dark" : "light"; };
applyTheme();
darkQuery.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
