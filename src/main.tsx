import React from "react";
import "./App.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import Spotlight from "./Spotlight";
import Settings from "./Settings";

const params = new URLSearchParams(window.location.search);
const isSpotlight = params.get("spotlight") === "1";
const isSettings = params.get("settings") === "1";

function Root() {
  if (isSpotlight) return <Spotlight />;
  if (isSettings) return <Settings />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
