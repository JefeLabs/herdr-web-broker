import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@jefelabs/herdr-broker-ui/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
