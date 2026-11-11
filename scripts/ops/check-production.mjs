import nextEnv from '@next/env';

// Preview deployments may use test services. Production must opt into live services.
if (process.argv.includes('--vercel') && process.env.VERCEL_ENV !== 'production') {
  console.log('Preview build: production-only environment checks skipped.');
  process.exit(0);
}
nextEnv.loadEnvConfig(process.cwd(), false);
const errors = [];
const required = ['DATABASE_URL', 'APP_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'CHATTERBOX_API_URL', 'CHATTERBOX_API_KEY', 'VITERBOX_API_URL', 'REALTIME_API_URL', 'REALTIME_SESSION_SECRET'];
for (const key of required) {
  const value = process.env[key]?.trim();
  if (!value || value === '[SENSITIVE]' || /[<>]/.test(value)) errors.push(`${key}: missing or contains a placeholder`);
}
for (const key of ['APP_URL', 'CHATTERBOX_API_URL', 'VITERBOX_API_URL', 'REALTIME_API_URL']) {
  try {
    const url = new URL(process.env[key]);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
  } catch { errors.push(`${key}: a public HTTPS URL is required`); }
}
for (const [key, livePrefix, testPrefix] of [
  ['CLERK_SECRET_KEY', 'sk_live_', 'sk_test_'],
  ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_live_', 'pk_test_'],
]) {
  const raw = process.env[key] ?? '';
  const value = raw.trim();
  // Classify only; never print credential values, lengths or encoded contents.
  if (value.startsWith(testPrefix)) errors.push(`${key}: Vercel supplied a Development/test key`);
  else if (value.startsWith(livePrefix) && raw !== value) errors.push(`${key}: live key has surrounding whitespace; re-save without spaces/newlines`);
  else if (!value.startsWith(livePrefix)) {
    const reason = !value ? 'empty' : value === '[SENSITIVE]' ? 'redacted placeholder' : /^["']/.test(value) ? 'contains wrapping quotes' : 'unrecognized key format';
    errors.push(`${key}: ${reason}; use the actual live key from Clerk`);
  }
}
if ((process.env.REALTIME_SESSION_SECRET?.length ?? 0) < 32) errors.push('REALTIME_SESSION_SECRET: must contain at least 32 characters');
if (process.env.SKIP_ENV_VALIDATION) errors.push('SKIP_ENV_VALIDATION: remove this override in production');
if (errors.length) {
  console.error('Production configuration is not ready:\n' + errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Production configuration checks passed. Database migration, service connectivity and authenticated flows still need verification.');
}
