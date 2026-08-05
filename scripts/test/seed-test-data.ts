#!/usr/bin/env tsx
/**
 * Seed Test Data for Local Development
 * 
 * Creates test users, organizations, and Slack connections in your local database
 * 
 * Usage:
 *   npm run test:seed
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables (.env.development takes precedence over .env)
dotenv.config({ path: path.resolve(process.cwd(), '.env.development') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function seedTestData() {
  console.log('='.repeat(80));
  console.log('🌱 Seeding Test Data');
  console.log('='.repeat(80));

  try {
    // 1. Create test organization
    console.log('\n📦 Creating test organization...');
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .upsert({
        slug: 'test-org',
        name: 'Test Organization',
      }, { onConflict: 'slug' })
      .select()
      .single();

    if (orgError) throw orgError;
    console.log('✅ Organization created:', org.id);

    // 2. Create test user
    console.log('\n👤 Creating test user...');
    
    // First check if user already exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    let userId: string;
    
    const existingUser = existingUsers.users.find(u => u.email === 'test@example.com');
    
    if (existingUser) {
      userId = existingUser.id;
      console.log('✅ Using existing user:', userId);
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: 'test@example.com',
        password: 'TestPassword123!',
        email_confirm: true,
        user_metadata: {
          first_name: 'Test',
          last_name: 'User',
        },
      });

      if (authError) throw authError;
      userId = authUser.user.id;
      console.log('✅ User created:', userId);
    }

    // 3. Create/update profile
    console.log('\n👤 Creating user profile...');
    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        user_id: userId,
        email: 'test@example.com',
        first_name: 'Test',
        last_name: 'User',
      }, { onConflict: 'user_id' });

    if (profileError) throw profileError;
    console.log('✅ Profile created/updated');

    // 4. Link user to organization
    console.log('\n🔗 Linking user to organization...');
    const { data: existingLink } = await supabase
      .from('organization_users')
      .select('id')
      .eq('organization_id', org.id)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingLink) {
      const { error: orgUserError } = await supabase
        .from('organization_users')
        .insert({
          organization_id: org.id,
          user_id: userId,
          role: 'admin',
        });
      if (orgUserError) throw orgUserError;
    }
    console.log('✅ User linked to organization');

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('✅ Test Data Seeded Successfully!');
    console.log('='.repeat(80));
    console.log('\n📋 Test Credentials:');
    console.log('   Email: test@example.com');
    console.log('   Password: TestPassword123!');
    console.log(`   User ID: ${userId}`);
    console.log(`   Organization ID: ${org.id}`);
    console.log('\n💡 You can now test with these credentials!');
    console.log('   Run `npm run test:seed-features` next for deal & meeting data.');
    console.log('\n' + '='.repeat(80));

  } catch (error) {
    console.error('\n❌ Error seeding data:', error);
    process.exit(1);
  }
}

// Run
seedTestData().catch(console.error);
