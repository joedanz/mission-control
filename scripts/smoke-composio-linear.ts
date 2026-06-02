// ABOUTME: Manual smoke harness proving the Composio agent-can-act loop — spawns a real `claude` via MC's
// ABOUTME: executor with the `composio-linear` profile and asserts it created + read back a Linear issue.
// ABOUTME: Run: `npm run smoke:composio` (loads .env.local; SKIPs cleanly without creds/profile).

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnExecutor, monitorAndFinalize, mc, type Log, type Spawned } from '../daemon/runner';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_SLUG = 'composio-linear';
const RUNBOOK = 'docs/runbooks/composio-linear-smoke.md';
const log: Log = (m) => console.log(`[smoke] ${m}`);

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}
function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

type SmokeResult = { issueId?: string; identifier?: string; url?: string; title?: string };

/** Pull the agent's final text from `claude -p --output-format json` stdout, then the MC_SMOKE_RESULT JSON. */
function parseSmokeResult(stdout: string): SmokeResult | null {
  let text = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { result?: unknown };
      if (typeof o.result === 'string') text = o.result;
    } catch {
      /* not a JSON line — skip */
    }
  }
  const m = text.match(/MC_SMOKE_RESULT:\s*(\{.*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as SmokeResult;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!process.env.COMPOSIO_API_KEY) {
    skip(`COMPOSIO_API_KEY not set — add it to .env.local (see ${RUNBOOK})`);
  }
  // Deferred so the COMPOSIO_API_KEY guard above can SKIP cleanly: importing lib/queries pulls in the
  // Neon client, which throws at module load when DATABASE_URL is unset (CI / a bare SKIP-path invocation).
  const { getProfileBySlug } = await import('../lib/queries');
  const profile = await getProfileBySlug(PROFILE_SLUG);
  if (!profile) {
    skip(`profile "${PROFILE_SLUG}" not found — create it per ${RUNBOOK}`);
  }
  if (!profile.mcpServers || Object.keys(profile.mcpServers).length === 0) {
    skip(`profile "${PROFILE_SLUG}" has no mcpServers — see ${RUNBOOK}`);
  }

  const runId = randomUUID();
  const marker = `MC-SMOKE-${runId.slice(0, 8)}`;
  const prompt = [
    'You are a smoke test for Mission Control. Using ONLY your Linear MCP tools:',
    '1. List your Linear teams and pick the first one.',
    `2. Create an issue in that team titled EXACTLY "${marker}" with body "Mission Control Composio smoke test".`,
    '3. Fetch that issue back by its id to confirm it persisted.',
    'Then output, as the LAST line of your reply, EXACTLY one line of JSON prefixed with "MC_SMOKE_RESULT: ":',
    `MC_SMOKE_RESULT: {"issueId":"<id>","identifier":"<TEAM-123>","url":"<url>","title":"${marker}"}`,
    'Output nothing after that line.',
  ].join('\n');

  // Open a real run so MC_RUN_ID + hooks bind exactly as in production.
  const started = await mc([
    'run', 'start', '--id', runId, '--agent', 'mc-smoke-composio',
    '--source', 'manual', '--profile', PROFILE_SLUG, '--work-dir', ROOT,
  ]);
  if (!started.ok) {
    fail(`mc run start failed: ${started.error?.code ?? started.code} ${started.error?.message ?? ''}`);
  }

  log(`spawning ${PROFILE_SLUG} (run ${runId.slice(0, 8)}, marker ${marker})`);
  let spawned: Spawned;
  try {
    spawned = spawnExecutor({
      prompt,
      runId,
      repoPath: ROOT,
      profile,
      effectiveModel: profile.model ?? null,
      basePermissionMode: 'bypassPermissions',
    });
  } catch (e) {
    await mc(['run', 'end', runId, 'failed']);
    fail(`spawn failed (likely MissingEnvError for a profile secret): ${(e as Error).message}`);
  }

  let status: string;
  try {
    ({ status } = await monitorAndFinalize(spawned, runId, { timeoutSec: 240, graceSec: 10 }, log));
  } catch (e) {
    await mc(['run', 'end', runId, 'failed']).catch(() => {});
    fail(`monitorAndFinalize threw — run ${runId.slice(0, 8)} forced to failed: ${(e as Error).message}`);
  }
  log(`run ${runId.slice(0, 8)} terminal status: ${status}`);
  if (status !== 'completed') {
    fail(`run did not complete (status=${status}) — the agent errored or timed out before finishing; see the teed claude output above.`);
  }

  const result = parseSmokeResult(spawned.output());
  if (!result) {
    const sawToken = spawned.output().includes('MC_SMOKE_RESULT');
    fail(
      sawToken
        ? `agent emitted a MC_SMOKE_RESULT line but its JSON could not be parsed (status=${status}). See the run output above.`
        : `agent did not emit MC_SMOKE_RESULT (status=${status}). The MCP server may not have loaded or the tool call failed — see the run output above.`,
    );
  }
  if (result.title !== marker) {
    fail(`issue title "${result.title}" != expected marker "${marker}" — wrong or hallucinated issue`);
  }
  if (!result.issueId || !result.url) {
    fail(`MC_SMOKE_RESULT missing issueId/url: ${JSON.stringify(result)}`);
  }

  console.log(`PASS: agent created + read back Linear issue ${result.identifier ?? result.issueId}`);
  console.log(`  url: ${result.url}`);
  console.log('  Out-of-band confirm: open the URL above (or the Composio dashboard) to eyeball the issue.');
  process.exit(0);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
