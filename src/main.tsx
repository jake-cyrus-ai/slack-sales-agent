import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import App from "./App";
import "./index.css";

async function start() {
  let clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!clerkKey) {
    const response = await fetch(`${(import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "")}/config`);
    const config = await response.json();
    clerkKey = config.clerkPublishableKey;
  }
  if (!clerkKey) throw new Error("Clerk publishable key is not configured on the server.");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><ClerkProvider publishableKey={clerkKey}><App /></ClerkProvider></React.StrictMode>,
  );
}

void start();
