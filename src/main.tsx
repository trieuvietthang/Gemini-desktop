import React from "react";
import "./App.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import Spotlight from "./Spotlight";

const isSpotlight = new URLSearchParams(window.location.search).get("spotlight") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSpotlight ? <Spotlight /> : <App />}
  </React.StrictMode>,
);
