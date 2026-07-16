import React from "react";
import "./App.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import Spotlight from "./Spotlight";
import Settings from "./Settings";
import Help from "./Help";

const params = new URLSearchParams(window.location.search);
const isSpotlight = params.get("spotlight") === "1";
const isSettings = params.get("settings") === "1";
const isHelp = params.get("help") === "1";

function Root() {
  if (isSpotlight) return <Spotlight />;
  if (isSettings) return <Settings />;
  if (isHelp) return <Help />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
