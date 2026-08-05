/**
 * Vitest setup file — runs before each test file is imported.
 *
 * Sets dummy environment variables so that eagerly-evaluated modules
 * (config.ts, lib/supabase.ts, etc.) can initialise without throwing.
 * None of these values are real credentials.
 */

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.SLACK_BOT_TOKEN = 'test-slack-token';
