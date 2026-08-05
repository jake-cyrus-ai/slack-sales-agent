import { SignInButton, UserButton, OrganizationSwitcher, useAuth, useOrganization } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { integrationNames } from "./integrations";

type IntegrationKey = "slack" | "google" | "salesforce" | "attio" | "granola";
type Statuses = Record<IntegrationKey, boolean>;

const apiBase = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

function PublicLanding() {
  return <main>
    <section className="hero">
      <span className="eyebrow">Open-source · Slack native</span>
      <h1>Slack-native sales agent</h1>
      <p>Bring your own provider keys, connect your business systems, and operate the sales agent from Slack.</p>
      <SignInButton mode="modal"><button className="primary">Start configuration</button></SignInButton>
    </section>
  </main>;
}

function Configuration() {
  const { getToken } = useAuth();
  const { organization, isLoaded } = useOrganization();
  const [statuses, setStatuses] = useState<Statuses>({ slack: false, google: false, salesforce: false, attio: false, granola: false });
  const [message, setMessage] = useState("Select or create an organization to begin.");
  const [busy, setBusy] = useState<string | null>(null);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getToken();
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!organization) return;
    try {
      const result = await request("/automation/integrations");
      setStatuses(result.data);
      setMessage("Connection status is current.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load connections.");
    }
  }, [organization, request]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (window.location.pathname !== "/email/callback") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    setBusy("google");
    request("/oauth/agent-email/callback", { method: "POST", body: JSON.stringify({ code, state }) })
      .then(() => { window.history.replaceState({}, "", "/"); return refresh(); })
      .then(() => setMessage("Google connected."))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Google connection failed."))
      .finally(() => setBusy(null));
  }, [request, refresh]);

  const connect = async (key: IntegrationKey) => {
    setBusy(key);
    setMessage(`Starting ${key} connection…`);
    try {
      const paths: Record<IntegrationKey, string> = {
        slack: "/oauth/slack/initiate",
        google: "/oauth/agent-email/initiate",
        salesforce: "/salesforce/oauth/initiate",
        attio: "/oauth/attio/initiate",
        granola: "/oauth/granola/initiate",
      };
      const result = await request(paths[key], { method: "POST", body: "{}" });
      const url = result.authUrl || result.url;
      if (!url) throw new Error("Provider did not return an authorization URL.");
      window.location.assign(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not connect ${key}.`);
      setBusy(null);
    }
  };

  return <main>
    <header><div><strong>Slack Sales Agent</strong><span>Configuration</span></div><UserButton /></header>
    <section className="hero compact">
      <span className="eyebrow">Bring your own keys</span>
      <h1>Connect your sales stack</h1>
      <p>This page configures the agent. Daily work happens in Slack.</p>
    </section>
    <section>
      <h2>1. Organization</h2>
      <p>Create or select the Clerk organization that owns shared Slack and CRM connections.</p>
      <OrganizationSwitcher hidePersonal afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" />
    </section>
    <section>
      <div className="section-title"><div><h2>2. Connections</h2><p>{message}</p></div><button onClick={() => void refresh()} disabled={!organization}>Refresh</button></div>
      {!isLoaded || !organization ? <div className="notice">Select or create an organization before connecting providers.</div> : <div className="grid">
        {integrationNames.map((name) => {
          const key = name.toLowerCase() as IntegrationKey;
          const connected = statuses[key];
          return <div className="card" key={name}>
            <div className="card-heading"><strong>{name}</strong><span className={connected ? "status connected" : "status"}>{connected ? "Connected" : "Not connected"}</span></div>
            <span>{key === "attio" || key === "granola" ? "Direct provider-hosted MCP OAuth" : "Deployer-owned OAuth application"}</span>
            <button className={connected ? "" : "primary"} disabled={busy !== null} onClick={() => void connect(key)}>{busy === key ? "Opening…" : connected ? "Reconnect" : "Connect"}</button>
          </div>;
        })}
      </div>}
    </section>
    <section>
      <h2>3. Test in Slack</h2>
      <p>After Slack and at least one context provider are connected, send the app a DM: “What can you help me with?”</p>
    </section>
  </main>;
}

export default function App() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <main><section>Loading configuration…</section></main>;
  return isSignedIn ? <Configuration /> : <PublicLanding />;
}
