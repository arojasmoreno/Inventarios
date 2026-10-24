import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
// PWA: registra el service worker para que la app arranque también sin cobertura.
// Ruta relativa: funciona en la raíz (producción/Worker) y en /Inventarios/ (GitHub Pages).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => { /* sin PWA no rompe nada */ }); });
}
