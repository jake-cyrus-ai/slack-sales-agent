#!/usr/bin/env tsx
/**
 * Trigger Inngest Function Directly
 * 
 * Usage:
 *   npm run test:inngest -- --event email/qualify --data '{"userId": "test-123"}'
 *   npm run test:inngest -- --event calendar/sync --data '{"userId": "test-123"}'
 */

// Parse command line arguments
const args = process.argv.slice(2);
const eventIndex = args.indexOf('--event');
const dataIndex = args.indexOf('--data');
const serverUrlIndex = args.indexOf('--server');

const eventName = eventIndex >= 0 ? args[eventIndex + 1] : null;
const eventData = dataIndex >= 0 ? args[dataIndex + 1] : '{}';
const serverUrl = serverUrlIndex >= 0 ? args[serverUrlIndex + 1] : 'http://localhost:8288';

async function triggerInngestFunction() {
  console.log('='.repeat(80));
  console.log('🧪 Triggering Inngest Function');
  console.log('='.repeat(80));

  if (!eventName) {
    console.error('❌ Event name is required');
    console.log('\nUsage:');
    console.log('  npm run test:inngest -- --event <event-name> --data \'<json-data>\'');
    console.log('\nExample events:');
    console.log('  email/qualify');
    console.log('  email/process');
    console.log('  email/approval-response');
    console.log('  calendar/sync');
    console.log('  calendar/meeting-prep');
    console.log('  document/uploaded');
    console.log('  knowledge-base/search');
    process.exit(1);
  }

  let parsedData: any;
  try {
    parsedData = JSON.parse(eventData);
  } catch (error) {
    console.error('❌ Invalid JSON in --data argument');
    process.exit(1);
  }

  const inngestEvent = {
    name: eventName,
    data: parsedData,
    user: {},
    v: '1',
    ts: Date.now(),
  };

  console.log(`\n📝 Event: ${eventName}`);
  console.log('📋 Data:');
  console.log(JSON.stringify(parsedData, null, 2));
  console.log(`\n📤 Sending to: ${serverUrl}/e/agent-ai`);

  try {
    const response = await fetch(`${serverUrl}/e/agent-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(inngestEvent),
    });

    console.log('\n' + '='.repeat(80));
    console.log(`📡 Response: ${response.status} ${response.statusText}`);
    console.log('='.repeat(80));

    if (response.ok) {
      const responseData = await response.json();
      console.log('\n✅ Response data:');
      console.log(JSON.stringify(responseData, null, 2));
      console.log('\n✅ Event sent successfully!');
      console.log('\n💡 Next steps:');
      console.log(`   1. Open Inngest Dev Server: ${serverUrl}`);
      console.log('   2. View function execution in "Runs" tab');
      console.log('   3. Inspect step-by-step execution');
    } else {
      const errorText = await response.text();
      console.log('\n❌ Error response:');
      console.log(errorText);
    }
  } catch (error) {
    console.error('\n❌ Error triggering function:', error);
    console.log('\n💡 Make sure Inngest Dev Server is running:');
    console.log('   npx inngest-cli@latest dev');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
}

// Run
triggerInngestFunction().catch(console.error);
