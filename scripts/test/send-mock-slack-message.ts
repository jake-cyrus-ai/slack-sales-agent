#!/usr/bin/env tsx
/**
 * Send Mock Slack Message to Local Server
 * 
 * Usage:
 *   npm run test:slack-message
 *   npm run test:slack-message -- --message meeting_prep_request
 *   npm run test:slack-message -- --custom '{"text": "Custom message"}'
 */

import slackMessages from '../../server/inngest/__tests__/fixtures/slack-messages.json';

// Parse command line arguments
const args = process.argv.slice(2);
const messageTypeIndex = args.indexOf('--message');
const customIndex = args.indexOf('--custom');
const serverUrlIndex = args.indexOf('--server');

const messageType = messageTypeIndex >= 0 ? args[messageTypeIndex + 1] : 'basic_message';
const customMessage = customIndex >= 0 ? args[customIndex + 1] : null;
const serverUrl = serverUrlIndex >= 0 ? args[serverUrlIndex + 1] : 'http://localhost:3001';

async function sendSlackMessage() {
  console.log('='.repeat(80));
  console.log('🧪 Sending Mock Slack Message');
  console.log('='.repeat(80));

  // Get message payload
  let messagePayload: any;
  
  if (customMessage) {
    try {
      messagePayload = JSON.parse(customMessage);
      console.log('📝 Using custom message');
    } catch (error) {
      console.error('❌ Invalid JSON in --custom argument');
      process.exit(1);
    }
  } else {
    messagePayload = (slackMessages as any)[messageType];
    if (!messagePayload) {
      console.error(`❌ Message type "${messageType}" not found`);
      console.log('\nAvailable message types:');
      Object.keys(slackMessages).forEach(key => console.log(`  - ${key}`));
      process.exit(1);
    }
    console.log(`📝 Using preset message: ${messageType}`);
  }

  // Wrap in Slack event envelope
  const slackEvent = {
    token: 'test-token',
    team_id: messagePayload.team,
    api_app_id: 'A12345TEST',
    event: messagePayload,
    type: 'event_callback',
    event_id: 'Ev' + Date.now(),
    event_time: Math.floor(Date.now() / 1000),
    authed_users: ['U0BOTID'],
  };

  console.log('\n📤 Sending to:', `${serverUrl}/api/test/slack/message`);
  console.log('\n📋 Payload:');
  console.log(JSON.stringify(slackEvent, null, 2));

  try {
    const response = await fetch(`${serverUrl}/api/test/slack/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(slackEvent),
    });

    console.log('\n' + '='.repeat(80));
    console.log(`📡 Response: ${response.status} ${response.statusText}`);
    console.log('='.repeat(80));

    const responseData = await response.json();
    console.log('\n✅ Response data:');
    console.log(JSON.stringify(responseData, null, 2));

    if (response.ok) {
      console.log('\n✅ Message sent successfully!');
      console.log('\n💡 Next steps:');
      console.log('   1. Check Inngest Dev Server dashboard: http://localhost:8288');
      console.log('   2. Monitor function execution and logs');
      console.log('   3. Check your database for created records');
    } else {
      console.log('\n❌ Message failed to send');
    }
  } catch (error) {
    console.error('\n❌ Error sending message:', error);
    console.log('\n💡 Make sure your server is running:');
    console.log('   npm run dev:server');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
}

// Run
sendSlackMessage().catch(console.error);
