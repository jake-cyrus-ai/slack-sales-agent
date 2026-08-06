import React from "react";
import ReactDOM from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import App from "./App";
import "./index.css";

async function start() {
  let url = import.meta.env.VITE_SUPABASE_URL;
  let key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const response = await fetch(`${(import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "")}/config`);
    const config = await response.json();
    url ||= config.supabaseUrl;
    key ||= config.supabasePublishableKey;
  }
  if (!url || !key) throw new Error("Supabase public configuration is missing.");
  const supabase = createClient(url, key);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App supabase={supabase} /></React.StrictMode>,
  );
}

void start();
