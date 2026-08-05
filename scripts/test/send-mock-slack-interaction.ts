#!/usr/bin/env tsx
/**
 * Send Mock Slack Interaction to Local Server
 * 
 * Usage:
 *   npm run test:slack-interaction
 *   npm run test:slack-interaction -- --interaction approve_email_draft
 *   npm run test:slack-interaction -- --custom '{"type": "block_actions", ...}'
 */

import slackInteractions from '../../server/inngest/__tests__/fixtures/slack-interactions.json';

// Parse command line arguments
const args = process.argv.slice(2);
const interactionTypeIndex = args.indexOf('--interaction');
const customIndex = args.indexOf('--custom');
const serverUrlIndex = args.indexOf('--server');

const interactionType = interactionTypeIndex >= 0 ? args[interactionTypeIndex + 1] : 'approve_email_draft';
const customInteraction = customIndex >= 0 ? args[customIndex + 1] : null;
const serverUrl = serverUrlIndex >= 0 ? args[serverUrlIndex + 1] : 'http://localhost:3001';

async function sendSlackInteraction() {
  console.log('='.repeat(80));
  console.log('🧪 Sending Mock Slack Interaction');
  console.log('='.repeat(80));

  // Get interaction payload
  let interactionPayload: any;
  
  if (customInteraction) {
    try {
      interactionPayload = JSON.parse(customInteraction);
      console.log('📝 Using custom interaction');
    } catch (error) {
      console.error('❌ Invalid JSON in --custom argument');
      process.exit(1);
    }
  } else {
    interactionPayload = (slackInteractions as any)[interactionType];
    if (!interactionPayload) {
      console.error(`❌ Interaction type "${interactionType}" not found`);
      console.log('\nAvailable interaction types:');
      Object.keys(slackInteractions).forEach(key => console.log(`  - ${key}`));
      process.exit(1);
    }
    console.log(`📝 Using preset interaction: ${interactionType}`);
  }

  console.log('\n📤 Sending to:', `${serverUrl}/api/test/slack/interaction`);
  console.log('\n📋 Payload:');
  console.log(JSON.stringify(interactionPayload, null, 2));

  try {
    // Slack sends interactions as URL-encoded form data
    const formData = new URLSearchParams();
    formData.append('payload', JSON.stringify(interactionPayload));

    const response = await fetch(`${serverUrl}/api/test/slack/interaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    console.log('\n' + '='.repeat(80));
    console.log(`📡 Response: ${response.status} ${response.statusText}`);
    console.log('='.repeat(80));

    const responseData = await response.json();
    console.log('\n✅ Response data:');
    console.log(JSON.stringify(responseData, null, 2));

    if (response.ok) {
      console.log('\n✅ Interaction sent successfully!');
      console.log('\n💡 Next steps:');
      console.log('   1. Check Inngest Dev Server dashboard: http://localhost:8288');
      console.log('   2. Monitor function execution and logs');
      console.log('   3. Check your database for updated records');
    } else {
      console.log('\n❌ Interaction failed to send');
    }
  } catch (error) {
    console.error('\n❌ Error sending interaction:', error);
    console.log('\n💡 Make sure your server is running:');
    console.log('   npm run dev:server');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
}

// Run
sendSlackInteraction().catch(console.error);
