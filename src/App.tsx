const integrations = ["Slack", "Gmail", "Google Calendar", "Salesforce", "Attio", "Granola"];

export default function App() {
  return <main>
    <section className="hero">
      <span className="eyebrow">Open-source · Slack native</span>
        <h1>Slack-native sales agent</h1>
      <p>Connect your business systems, prepare meetings, draft and approve emails, update CRM records, and run configurable autonomous email workflows.</p>
    </section>
    <section>
      <h2>Onboarding</h2>
      <ol>
        <li>Install the Slack application.</li>
        <li>Sign in and create or join an organization.</li>
        <li>Connect the systems your team uses.</li>
        <li>Configure approval and autonomous-email policies.</li>
        <li>Send the agent a test message in Slack.</li>
      </ol>
    </section>
    <section>
      <h2>Integrations</h2>
      <div className="grid">{integrations.map(name => <div className="card" key={name}><strong>{name}</strong><span>Configure through the authenticated API and provider OAuth flow.</span></div>)}</div>
    </section>
    <section>
      <h2>Safety defaults</h2>
      <p>Draft sends and CRM mutations require approval unless an organization explicitly enables a narrower autonomous policy. Every action remains tenant-scoped and auditable.</p>
    </section>
  </main>;
}
