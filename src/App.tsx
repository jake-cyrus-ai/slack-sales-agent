import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { integrationNames } from "./integrations";

type IntegrationKey = "slack" | "google" | "salesforce" | "attio" | "granola";
type Statuses = Record<IntegrationKey, boolean>;
type OrganizationEntry = {
  role: "owner" | "admin" | "member";
  organizations: { id: string; name: string; slug: string };
};

const apiBase = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

function SignIn({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState("");
  const submit = async () => {
    setMessage("Working…");
    const result = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (result.error) setMessage(result.error.message);
    else if (mode === "signup" && !result.data.session) setMessage("Check your email to confirm your account.");
  };
  return <main><section className="hero">
    <span className="eyebrow">Open-source · Slack native</span>
    <h1>Slack-native sales agent</h1>
    <p>Sign in to install Slack and connect your business systems.</p>
    <div className="card">
      <input aria-label="Email" type="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
      <input aria-label="Password" type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
      <button className="primary" onClick={() => void submit()}>{mode === "signin" ? "Sign in" : "Create account"}</button>
      <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>{mode === "signin" ? "Create an account" : "Use an existing account"}</button>
      {message && <p>{message}</p>}
    </div>
  </section></main>;
}

function Configuration({ supabase, session }: { supabase: SupabaseClient; session: Session }) {
  const [organizations, setOrganizations] = useState<OrganizationEntry[]>([]);
  const [organizationId, setOrganizationId] = useState(() => localStorage.getItem("sales-agent-org") || "");
  const [organizationName, setOrganizationName] = useState("");
  const [statuses, setStatuses] = useState<Statuses>({ slack: false, google: false, salesforce: false, attio: false, granola: false });
  const [message, setMessage] = useState("Create or select an organization to begin.");
  const [busy, setBusy] = useState<string | null>(null);

  const request = useCallback(async (path: string, init: RequestInit = {}, orgOverride?: string) => {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        ...((orgOverride ?? organizationId) ? { "X-Organization-ID": orgOverride ?? organizationId } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }, [organizationId, session.access_token]);

  const loadOrganizations = useCallback(async () => {
    await request("/user/ensure-profile", { method: "POST", body: JSON.stringify({ email: session.user.email }) });
    const result = await request("/user/organizations");
    const entries = result.organizations as OrganizationEntry[];
    setOrganizations(entries);
    if (!organizationId && entries[0]?.organizations.id) {
      setOrganizationId(entries[0].organizations.id);
      localStorage.setItem("sales-agent-org", entries[0].organizations.id);
    }
  }, [organizationId, request, session.user.email]);

  const refresh = useCallback(async () => {
    if (!organizationId) return;
    try {
      const result = await request("/automation/integrations");
      setStatuses(result.data);
      setMessage("Connection status is current.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load connections.");
    }
  }, [organizationId, request]);

  useEffect(() => { void loadOrganizations(); }, [loadOrganizations]);
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

  const createOrganization = async () => {
    setBusy("organization");
    try {
      const result = await request("/user/organizations", { method: "POST", body: JSON.stringify({ name: organizationName }) }, "");
      const id = result.organization.id as string;
      setOrganizationId(id);
      localStorage.setItem("sales-agent-org", id);
      setOrganizationName("");
      await loadOrganizations();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create organization."); }
    finally { setBusy(null); }
  };

  const connect = async (key: IntegrationKey) => {
    setBusy(key);
    try {
      const paths: Record<IntegrationKey, string> = { slack: "/oauth/slack/initiate", google: "/oauth/agent-email/initiate", salesforce: "/salesforce/oauth/initiate", attio: "/oauth/attio/initiate", granola: "/oauth/granola/initiate" };
      const result = await request(paths[key], { method: "POST", body: "{}" });
      const url = result.authUrl || result.url;
      if (!url) throw new Error("Provider did not return an authorization URL.");
      window.location.assign(url);
    } catch (error) { setMessage(error instanceof Error ? error.message : `Could not connect ${key}.`); setBusy(null); }
  };

  return <main>
    <header><div><strong>Slack Sales Agent</strong><span>Configuration</span></div><button onClick={() => void supabase.auth.signOut()}>Sign out</button></header>
    <section className="hero compact"><span className="eyebrow">Bring your own keys</span><h1>Connect your sales stack</h1><p>This page configures the agent. Daily work happens in Slack.</p></section>
    <section><h2>1. Organization</h2><p>Connections and preferences are isolated by organization.</p>
      {organizations.length > 0 && <select value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); localStorage.setItem("sales-agent-org", event.target.value); }}>
        {organizations.map((entry) => <option key={entry.organizations.id} value={entry.organizations.id}>{entry.organizations.name} ({entry.role})</option>)}
      </select>}
      <div><input placeholder="New organization name" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} /><button onClick={() => void createOrganization()} disabled={organizationName.trim().length < 2 || busy !== null}>Create organization</button></div>
    </section>
    <section><div className="section-title"><div><h2>2. Connections</h2><p>{message}</p></div><button onClick={() => void refresh()} disabled={!organizationId}>Refresh</button></div>
      {!organizationId ? <div className="notice">Create or select an organization before connecting providers.</div> : <div className="grid">{integrationNames.map((name) => {
        const key = name.toLowerCase() as IntegrationKey; const connected = statuses[key];
        return <div className="card" key={name}><div className="card-heading"><strong>{name}</strong><span className={connected ? "status connected" : "status"}>{connected ? "Connected" : "Not connected"}</span></div><span>{key === "attio" || key === "granola" ? "Direct provider-hosted MCP OAuth" : "Deployer-owned OAuth application"}</span><button className={connected ? "" : "primary"} disabled={busy !== null} onClick={() => void connect(key)}>{busy === key ? "Opening…" : connected ? "Reconnect" : "Connect"}</button></div>;
      })}</div>}
    </section>
    <section><h2>3. Test in Slack</h2><p>After Slack and a context provider are connected, send the app a DM: “What can you help me with?”</p></section>
  </main>;
}

export default function App({ supabase }: { supabase: SupabaseClient }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, [supabase]);
  if (session === undefined) return <main><section>Loading configuration…</section></main>;
  return session ? <Configuration supabase={supabase} session={session} /> : <SignIn supabase={supabase} />;
}
