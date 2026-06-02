// ABOUTME: Stand-alone reaper — flips stale `running` runs to 'abandoned' (no heartbeat within the
// ABOUTME: stale window) and emits run.abandoned. Run on a schedule via local cron/launchd instead of
// ABOUTME: a hosted cron. Usage: `npm run reap`. Uses DATABASE_URL from .env.local.

import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { runReaperTick } = await import('../lib/mutations');
  const { reaped, reconciled } = await runReaperTick();
  const when = new Date().toISOString();
  const parts: string[] = [];
  if (reaped.length) parts.push(`abandoned ${reaped.length} stale run(s): ${reaped.map((r) => r.id).join(', ')}`);
  if (reconciled.length)
    parts.push(`reconciled ${reconciled.length} dangling claim(s): ${reconciled.map((r) => r.runId).join(', ')}`);
  console.log(parts.length ? `[reap ${when}] ${parts.join('; ')}` : `[reap ${when}] no stale runs`);
}

main().catch((e) => {
  // Drizzle wraps the real driver error (e.g. NeonDbError, carrying the pg `code`/detail) in `.cause` —
  // the top-level message is the generic "Failed query …". Walk the cause chain so an outage is
  // root-causable from /tmp/mc-reap.log instead of a wall of indistinguishable "Failed query" lines.
  const parts = [e instanceof Error ? e.message : String(e)];
  for (let c: unknown = (e as { cause?: unknown })?.cause; c != null; c = (c as { cause?: unknown }).cause) {
    const code = (c as { code?: string }).code;
    parts.push(`cause: ${c instanceof Error ? c.message : String(c)}${code ? ` [${code}]` : ''}`);
  }
  console.error('[reap]', parts.join(' | '));
  process.exit(1);
});
