import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("popup: #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
