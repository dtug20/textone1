import { spawnSync } from 'node:child_process';

if (process.env.VERCEL_ENV !== 'production') {
  console.log('Automatic database migration is limited to production deployments.');
  process.exit(0);
}
// Run after the application compiles, before Vercel marks deployment ready.
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
