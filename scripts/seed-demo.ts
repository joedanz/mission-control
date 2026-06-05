// ABOUTME: Deterministic demo seed for capturing docs screenshots — fictional "Northwind Labs" studio.
// ABOUTME: GUARDED to the isolated `demo` Neon branch (refuses any other host) so the truncate can never
// ABOUTME: touch dev/prod. Run: `npm run seed:demo` (tsx --env-file=.env.demo scripts/seed-demo.ts).

import { config } from 'dotenv';

// Load .env.demo as a fallback (npm run seed:demo also passes --env-file=.env.demo).
config({ path: '.env.demo' });

// ── Safety guard ────────────────────────────────────────────────────────────────
// The truncate below wipes the app tables. Make it physically impossible to run against anything
// but the dedicated demo branch: the connection host MUST contain this endpoint id.
const DEMO_ENDPOINT = 'ep-muddy-haze-apje19tl';
const dbUrl = process.env.DATABASE_URL ?? '';
if (!dbUrl.includes(DEMO_ENDPOINT)) {
  console.error(
    `\n✋ Refusing to seed.\n` +
      `   scripts/seed-demo.ts truncates the app tables and only runs against the demo branch.\n` +
      `   DATABASE_URL must point at endpoint "${DEMO_ENDPOINT}".\n` +
      `   Use: npm run seed:demo  (loads .env.demo)\n`,
  );
  process.exit(1);
}

// ── Time helpers (relative to now, so the dashboard looks live at capture time) ──────
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms);
const ymd = (ms: number) => ago(ms).toISOString().slice(0, 10);

async function main() {
  // Import AFTER the guard so a misconfigured env fails on the guard, not a confusing import error.
  const {
    db,
    projects,
    tasks,
    runs,
    events,
    agentProfiles,
    mcpConnections,
    composioToolkits,
    workflows,
    workflowRuns,
    workflowStepRuns,
  } = await import('../lib/db');
  const { sql } = await import('drizzle-orm');

  console.log('• Truncating app tables on the demo branch…');
  await db.execute(sql`TRUNCATE TABLE
    workflow_step_runs, workflow_runs, workflows,
    mcp_connections, composio_toolkits,
    events, runs, tasks, agent_profiles, projects
    RESTART IDENTITY CASCADE`);

  // ── Projects ────────────────────────────────────────────────────────────────────
  const P = {
    habitcraft: 'demo-proj-habitcraft',
    dispatch: 'demo-proj-dispatch',
    tempo: 'demo-proj-tempo',
    site: 'demo-proj-site',
    atlas: 'demo-proj-atlas',
    borealis: 'demo-proj-borealis',
    pixel: 'demo-proj-pixel',
    legacy: 'demo-proj-legacy',
  };

  console.log('• Seeding projects…');
  await db.insert(projects).values([
    {
      id: P.habitcraft, name: 'Habitcraft', slug: 'habitcraft', domain: 'habitcraft.app',
      category: 'internal', status: 'launched', accent: 'blue',
      techStack: ['React Native', 'Expo', 'Convex'], liveUrl: 'https://habitcraft.app',
      repoUrl: 'https://github.com/northwind-labs/habitcraft', priority: 'high',
      description: 'Habit-tracking mobile app with streaks and gentle nudges.',
      notes: 'Flagship consumer product. App Store launch behind us; iterating on retention.',
      sortOrder: 0, targetDate: ymd(-21 * DAY), createdAt: ago(120 * DAY),
      updatedAt: ago(2 * HOUR), lastActivityAt: ago(8 * MIN),
    },
    {
      id: P.dispatch, name: 'Dispatch', slug: 'dispatch', domain: 'dispatch.email',
      category: 'internal', status: 'active', accent: 'green',
      techStack: ['Next.js', 'Postgres', 'Resend'], liveUrl: 'https://dispatch.email',
      repoUrl: 'https://github.com/northwind-labs/dispatch', priority: 'high',
      description: 'Newsletter tool for indie makers — write, schedule, and measure.',
      notes: 'Paid beta. Onboarding funnel is the current focus.',
      sortOrder: 1, targetDate: ymd(-35 * DAY), createdAt: ago(90 * DAY),
      updatedAt: ago(40 * MIN), lastActivityAt: ago(3 * MIN),
    },
    {
      id: P.tempo, name: 'Tempo CLI', slug: 'tempo-cli',
      category: 'open_source', status: 'active', accent: 'violet',
      techStack: ['Rust', 'clap'], repoUrl: 'https://github.com/northwind-labs/tempo',
      priority: 'medium', description: 'A fast, scriptable time-tracker for the terminal.',
      notes: 'Open source. 1.4k stars; community PRs trickling in.',
      sortOrder: 2, createdAt: ago(200 * DAY), updatedAt: ago(5 * HOUR), lastActivityAt: ago(5 * HOUR),
    },
    {
      id: P.site, name: 'Northwind Site', slug: 'northwind-site', domain: 'northwind-labs.dev',
      category: 'internal', status: 'launched', accent: 'orange',
      techStack: ['Astro', 'Tailwind'], liveUrl: 'https://northwind-labs.dev', priority: 'low',
      description: 'The studio marketing site and product index.',
      sortOrder: 3, createdAt: ago(150 * DAY), updatedAt: ago(2 * DAY), lastActivityAt: ago(2 * DAY),
    },
    {
      id: P.atlas, name: 'Atlas API', slug: 'atlas-api',
      category: 'internal', status: 'active', accent: 'warm',
      techStack: ['Go', 'Postgres', 'Fly.io'], priority: 'medium',
      description: 'Shared internal API powering auth, billing, and email across products.',
      notes: 'Backbone service. Stability over features.',
      sortOrder: 4, createdAt: ago(170 * DAY), updatedAt: ago(26 * HOUR), lastActivityAt: ago(26 * HOUR),
    },
    {
      id: P.borealis, name: 'Borealis Rebrand', slug: 'borealis-rebrand',
      category: 'client', status: 'design', accent: 'blue',
      techStack: ['Figma', 'Next.js'], priority: 'high',
      description: 'Client engagement: full rebrand + marketing site for an arctic-tourism startup.',
      notes: 'Client work. Design review scheduled Friday.',
      sortOrder: 5, targetDate: ymd(-30 * DAY), createdAt: ago(28 * DAY),
      updatedAt: ago(6 * HOUR), lastActivityAt: ago(6 * HOUR),
    },
    {
      id: P.pixel, name: 'Pixel Press', slug: 'pixel-press',
      category: 'internal', status: 'planning', accent: 'green',
      techStack: ['Astro', 'MDX'], priority: 'low',
      description: 'A devlog + changelog blog for the whole studio.',
      sortOrder: 6, createdAt: ago(14 * DAY), updatedAt: ago(3 * DAY), lastActivityAt: ago(3 * DAY),
    },
    {
      id: P.legacy, name: 'Legacy Importer', slug: 'legacy-importer',
      category: 'internal', status: 'testing', accent: 'warm',
      techStack: ['Node.js'], priority: 'low',
      description: 'One-off data importer for migrating off the old stack. Winding down.',
      archived: true, sortOrder: 7, createdAt: ago(220 * DAY), updatedAt: ago(45 * DAY),
      lastActivityAt: ago(45 * DAY),
    },
  ]);

  // ── Agent profiles ───────────────────────────────────────────────────────────────
  const PR = {
    builder: 'demo-prof-builder',
    researcher: 'demo-prof-researcher',
    nightly: 'demo-prof-nightly',
    exec: 'demo-prof-exec',
    fallback: 'demo-prof-default',
  };
  console.log('• Seeding agent profiles…');
  await db.insert(agentProfiles).values([
    {
      id: PR.builder, slug: 'builder', name: 'Builder', description: 'Hands-on implementer for internal products.',
      runtime: 'claude-code', model: 'opus', fallbackModel: 'claude-sonnet-4-6', dailyBudgetMicros: 25_000_000,
      permissionMode: 'acceptEdits', skills: ['frontend-design', 'testing'],
      allowedTools: ['Edit', 'Write', 'Bash'], matchRules: { projectCategories: ['internal'] },
      priority: 10, enabled: true, createdAt: ago(60 * DAY), updatedAt: ago(4 * DAY),
    },
    {
      id: PR.researcher, slug: 'researcher', name: 'Researcher', description: 'Read-only investigator; plans before touching code.',
      runtime: 'claude-code', model: 'claude-sonnet-4-6', permissionMode: 'plan', skills: ['deep-research'],
      matchRules: { labelPattern: 'research|investigate|spike' }, priority: 5, enabled: true,
      createdAt: ago(60 * DAY), updatedAt: ago(9 * DAY),
    },
    {
      id: PR.nightly, slug: 'nightly-checkin', name: 'Nightly Check-in',
      description: 'Wakes each morning to triage Habitcraft’s queue.',
      runtime: 'claude-code', model: 'opus', permissionMode: 'acceptEdits',
      scheduleEnabled: true, scheduleProjectId: P.habitcraft, scheduleCron: '0 9 * * *',
      scheduleTimezone: 'America/New_York', checkInPrompt: 'Triage Habitcraft’s queued tasks and pick up the top one.',
      lastCheckInAt: ago(22 * HOUR), priority: 0, enabled: true, createdAt: ago(40 * DAY), updatedAt: ago(22 * HOUR),
    },
    {
      id: PR.exec, slug: 'gpt-runner', name: 'GPT Runner', description: 'Non-Claude executor for cheap bulk edits.',
      runtime: 'exec', model: 'gpt-4o', provider: 'openai', execTemplate: 'codex exec --model ${MODEL} "${PROMPT}"',
      env: { OPENAI_API_KEY: '${OPENAI_API_KEY}' }, priority: 1, enabled: false,
      createdAt: ago(30 * DAY), updatedAt: ago(30 * DAY),
    },
    {
      id: PR.fallback, slug: 'default', name: 'Default', description: 'Global fallback when no rule matches.',
      runtime: 'claude-code', model: 'opus', permissionMode: 'default', isDefault: true, priority: 0, enabled: true,
      createdAt: ago(60 * DAY), updatedAt: ago(60 * DAY),
    },
  ]);

  // ── Runs ────────────────────────────────────────────────────────────────────────
  // (projectId, profileId, title, status, model, startMsAgo, durationMin, tokensIn, tokensOut, cacheRead, costMicros)
  type RunSpec = [string, string, string | null, string, string, string, number, number, number, number, number, number];
  const runSpecs: RunSpec[] = [
    ['demo-run-01', P.habitcraft, PR.builder, 'Add streak freeze feature', 'running', 'opus', 11 * MIN, 0, 184_000, 12_400, 920_000, 410_000],
    ['demo-run-02', P.dispatch, PR.builder, 'Rework onboarding step 2', 'running', 'opus', 4 * MIN, 0, 96_000, 7_100, 540_000, 233_000],
    ['demo-run-03', P.borealis, PR.researcher, 'Audit competitor sites', 'running', 'claude-sonnet-4-6', 18 * MIN, 0, 142_000, 9_800, 380_000, 96_000],
    ['demo-run-04', P.habitcraft, PR.builder, 'Fix notification timezone bug', 'completed', 'opus', 3 * HOUR, 42, 221_000, 18_300, 1_240_000, 612_000],
    ['demo-run-05', P.dispatch, PR.builder, 'Migrate to Resend batch API', 'completed', 'opus', 6 * HOUR, 58, 308_000, 24_600, 1_810_000, 884_000],
    ['demo-run-06', P.atlas, PR.builder, 'Rotate Fly.io secrets', 'completed', 'opus', 26 * HOUR, 17, 64_000, 4_200, 210_000, 119_000],
    ['demo-run-07', P.tempo, PR.researcher, 'Investigate flaky timer test', 'completed', 'claude-sonnet-4-6', 5 * HOUR, 23, 88_000, 6_400, 290_000, 74_000],
    ['demo-run-08', P.habitcraft, PR.builder, 'Polish empty states', 'completed', 'opus', 28 * HOUR, 35, 156_000, 13_900, 940_000, 470_000],
    ['demo-run-09', P.dispatch, PR.researcher, 'Spike: deliverability scoring', 'completed', 'claude-sonnet-4-6', 2 * DAY, 31, 119_000, 8_800, 360_000, 91_000],
    ['demo-run-10', P.borealis, PR.builder, 'Build hero section', 'completed', 'opus', 7 * HOUR, 49, 244_000, 21_100, 1_360_000, 690_000],
    ['demo-run-11', P.atlas, PR.builder, 'Add rate-limit middleware', 'failed', 'opus', 30 * HOUR, 12, 71_000, 3_100, 220_000, 134_000],
    ['demo-run-12', P.tempo, null, 'Triage GitHub issues', 'completed', 'opus', 9 * HOUR, 19, 52_000, 4_900, 180_000, 102_000],
    ['demo-run-13', P.habitcraft, PR.nightly, 'Nightly check-in', 'completed', 'opus', 22 * HOUR, 8, 38_000, 2_400, 120_000, 61_000],
    ['demo-run-14', P.site, PR.builder, 'Update pricing copy', 'completed', 'opus', 2 * DAY, 14, 47_000, 3_600, 160_000, 78_000],
    ['demo-run-15', P.dispatch, PR.builder, 'Fix double-send race', 'failed', 'opus', 3 * DAY, 27, 132_000, 6_700, 470_000, 248_000],
    ['demo-run-16', P.habitcraft, PR.builder, 'Add weekly summary email', 'completed', 'opus', 3 * DAY, 51, 268_000, 22_900, 1_520_000, 742_000],
    ['demo-run-17', P.borealis, PR.researcher, 'Moodboard research', 'completed', 'claude-sonnet-4-6', 4 * DAY, 22, 94_000, 7_200, 300_000, 79_000],
    ['demo-run-18', P.atlas, PR.builder, 'DB index tuning', 'completed', 'opus', 4 * DAY, 33, 141_000, 11_200, 720_000, 356_000],
    ['demo-run-19', P.tempo, null, 'Release v1.4.0', 'completed', 'opus', 5 * DAY, 16, 61_000, 5_400, 210_000, 118_000],
    ['demo-run-20', P.dispatch, PR.builder, 'Abandoned: editor refactor', 'abandoned', 'opus', 36 * HOUR, 9, 44_000, 1_900, 140_000, 71_000],
  ];

  console.log('• Seeding runs…');
  await db.insert(runs).values(
    runSpecs.map(([id, projectId, profileId, title, status, model, startAgo, durMin, tin, tout, cache, cost]) => {
      const startedAt = ago(startAgo);
      const isRunning = status === 'running';
      const endedAt = isRunning ? null : ago(startAgo - durMin * MIN);
      const lastHeartbeatAt = isRunning ? ago(Math.min(startAgo, 90 * 1000)) : (endedAt ?? startedAt);
      return {
        id, agentLabel: 'claude-code', projectId, agentProfileId: profileId, title,
        status, source: 'hook' as const, model,
        tokensIn: tin, tokensOut: tout, cacheReadTokens: cache, cacheWriteTokens: Math.round(cache * 0.15),
        costMicros: cost, sessionId: `sess-${id}`, workDir: `/Users/demo/code/${projectId.replace('demo-proj-', '')}`,
        transcriptRef: `~/.claude/projects/${id}/transcript.jsonl`,
        startedAt, endedAt: endedAt ?? undefined, lastHeartbeatAt,
      };
    }),
  );

  // ── Tasks ────────────────────────────────────────────────────────────────────────
  // (projectId, label, status, sortOrder, claimedByRunId?, doneAgoMs?)
  type TaskSpec = [string, string, string, string, number, string?, number?];
  const taskSpecs: TaskSpec[] = [
    ['demo-task-01', P.habitcraft, 'Add streak freeze feature', 'in_progress', 0, 'demo-run-01'],
    ['demo-task-02', P.habitcraft, 'Redesign the weekly summary email', 'todo', 1],
    ['demo-task-03', P.habitcraft, 'Investigate retention drop on day 7', 'todo', 2],
    ['demo-task-04', P.habitcraft, 'Fix notification timezone bug', 'done', 3, undefined, 3 * HOUR],
    ['demo-task-05', P.habitcraft, 'Polish empty states', 'done', 4, undefined, 28 * HOUR],
    ['demo-task-06', P.dispatch, 'Rework onboarding step 2', 'in_progress', 0, 'demo-run-02'],
    ['demo-task-07', P.dispatch, 'Add deliverability score to dashboard', 'todo', 1],
    ['demo-task-08', P.dispatch, 'Spike: deliverability scoring', 'done', 2, undefined, 2 * DAY],
    ['demo-task-09', P.dispatch, 'Migrate to Resend batch API', 'done', 3, undefined, 6 * HOUR],
    ['demo-task-10', P.atlas, 'Add rate-limit middleware', 'todo', 0],
    ['demo-task-11', P.atlas, 'DB index tuning', 'done', 1, undefined, 4 * DAY],
    ['demo-task-12', P.atlas, 'Rotate Fly.io secrets', 'done', 2, undefined, 26 * HOUR],
    ['demo-task-13', P.borealis, 'Audit competitor sites', 'in_progress', 0, 'demo-run-03'],
    ['demo-task-14', P.borealis, 'Build hero section', 'done', 1, undefined, 7 * HOUR],
    ['demo-task-15', P.borealis, 'Present design directions to client', 'todo', 2],
    ['demo-task-16', P.tempo, 'Triage community issues', 'todo', 0],
    ['demo-task-17', P.tempo, 'Investigate flaky timer test', 'done', 1, undefined, 5 * HOUR],
    ['demo-task-18', P.tempo, 'Cut v1.4.0 release', 'done', 2, undefined, 5 * DAY],
    ['demo-task-19', P.pixel, 'Draft first devlog post', 'todo', 0],
    ['demo-task-20', P.pixel, 'Pick a syntax-highlight theme', 'todo', 1],
    ['demo-task-21', P.site, 'Update pricing copy', 'done', 0, undefined, 2 * DAY],
  ];

  console.log('• Seeding tasks…');
  await db.insert(tasks).values(
    taskSpecs.map(([id, projectId, label, status, sortOrder, claim, doneAgo]) => ({
      id, projectId, label, status, sortOrder,
      claimedByRunId: claim ?? undefined,
      claimedAt: claim ? ago(10 * MIN) : undefined,
      claimExpiresAt: claim ? new Date(NOW + 50 * MIN) : undefined,
      completedAt: status === 'done' && doneAgo ? ago(doneAgo) : undefined,
      createdAt: ago(10 * DAY), updatedAt: ago(status === 'done' && doneAgo ? doneAgo : 1 * HOUR),
    })),
  );

  // ── Events (feed + run trails) ────────────────────────────────────────────────────
  console.log('• Seeding events…');
  type Ev = {
    id: string; runId?: string; projectId?: string; taskId?: string; actor: string;
    type: string; level?: string; summary: string; agoMs: number; tokens?: number; costMicros?: number;
  };
  const evs: Ev[] = [];
  let n = 0;
  const push = (e: Ev) => evs.push(e);

  // Derive started/ended events from each run.
  for (const [id, projectId, , title, status, , startAgo, durMin, , , , cost] of runSpecs) {
    push({ id: `demo-ev-${++n}`, runId: id, projectId, actor: 'claude-code', type: 'run.started', summary: `Started: ${title}`, agoMs: startAgo });
    if (status !== 'running') {
      const endedAgo = startAgo - durMin * MIN;
      const lvl = status === 'failed' ? 'error' : status === 'abandoned' ? 'warn' : 'info';
      const verb = status === 'failed' ? 'Failed' : status === 'abandoned' ? 'Abandoned' : 'Completed';
      push({ id: `demo-ev-${++n}`, runId: id, projectId, actor: 'claude-code', type: 'run.ended', level: lvl, summary: `${verb}: ${title}`, agoMs: Math.max(endedAgo, 0), costMicros: cost, tokens: 0 });
    }
  }
  // A few task lifecycle + note + tool_call events for texture.
  push({ id: `demo-ev-${++n}`, projectId: P.habitcraft, taskId: 'demo-task-01', runId: 'demo-run-01', actor: 'claude-code', type: 'task.claimed', summary: 'Claimed “Add streak freeze feature”', agoMs: 10 * MIN });
  push({ id: `demo-ev-${++n}`, projectId: P.dispatch, taskId: 'demo-task-06', runId: 'demo-run-02', actor: 'claude-code', type: 'task.claimed', summary: 'Claimed “Rework onboarding step 2”', agoMs: 4 * MIN });
  push({ id: `demo-ev-${++n}`, projectId: P.habitcraft, taskId: 'demo-task-04', actor: 'claude-code', type: 'task.status_changed', summary: '“Fix notification timezone bug” → done', agoMs: 3 * HOUR });
  push({ id: `demo-ev-${++n}`, projectId: P.dispatch, taskId: 'demo-task-09', actor: 'claude-code', type: 'task.status_changed', summary: '“Migrate to Resend batch API” → done', agoMs: 6 * HOUR });
  push({ id: `demo-ev-${++n}`, projectId: P.habitcraft, taskId: 'demo-task-02', actor: 'joe@northwind-labs.dev', type: 'task.created', summary: 'Added “Redesign the weekly summary email”', agoMs: 5 * HOUR });
  push({ id: `demo-ev-${++n}`, projectId: P.borealis, runId: 'demo-run-03', actor: 'claude-code', type: 'tool_call', level: 'debug', summary: 'WebFetch borealis-competitors', agoMs: 16 * MIN });
  push({ id: `demo-ev-${++n}`, projectId: P.atlas, runId: 'demo-run-11', actor: 'claude-code', type: 'run.ended', level: 'error', summary: 'Rate-limit middleware: tests failed', agoMs: 30 * HOUR - 12 * MIN });
  push({ id: `demo-ev-${++n}`, projectId: P.dispatch, actor: 'mc', type: 'composio.connection_changed', summary: 'Slack connection → active', agoMs: 12 * HOUR });
  push({ id: `demo-ev-${++n}`, projectId: P.atlas, actor: 'mc', type: 'composio.connection_changed', level: 'warn', summary: 'Linear connection → error (token expired)', agoMs: 20 * HOUR });
  push({ id: `demo-ev-${++n}`, actor: 'joe@northwind-labs.dev', type: 'note', summary: 'Demo data — fictional Northwind Labs studio', agoMs: 1 * MIN });

  await db.insert(events).values(
    evs.map((e) => ({
      id: e.id, runId: e.runId, projectId: e.projectId, taskId: e.taskId, actorLabel: e.actor,
      type: e.type, level: e.level ?? 'info', summary: e.summary,
      tokens: e.tokens, costMicros: e.costMicros, createdAt: ago(e.agoMs),
    })),
  );

  // ── MCP connections (+ toolkit cache) ─────────────────────────────────────────────
  console.log('• Seeding MCP connections…');
  await db.insert(composioToolkits).values([
    { slug: 'linear', authConfigId: 'ac_demo_linear', mcpServerId: 'mcp_demo_linear', mcpUrl: 'https://backend.composio.dev/v3/mcp/demo-linear' },
    { slug: 'slack', authConfigId: 'ac_demo_slack', mcpServerId: 'mcp_demo_slack', mcpUrl: 'https://backend.composio.dev/v3/mcp/demo-slack' },
  ]);
  await db.insert(mcpConnections).values([
    {
      id: 'demo-mcp-01', projectId: P.habitcraft, source: 'composio', toolkitSlug: 'linear',
      userId: `mc-proj-${P.habitcraft}`, connectedAccountId: 'ca_demo_habit_linear', status: 'active',
      createdAt: ago(30 * DAY), updatedAt: ago(2 * DAY),
    },
    {
      id: 'demo-mcp-02', projectId: P.dispatch, source: 'composio', toolkitSlug: 'slack',
      userId: `mc-proj-${P.dispatch}`, connectedAccountId: 'ca_demo_dispatch_slack', status: 'active',
      createdAt: ago(20 * DAY), updatedAt: ago(12 * HOUR),
    },
    {
      id: 'demo-mcp-03', projectId: P.dispatch, source: 'remote', remoteName: 'docs-search',
      remoteUrl: 'https://mcp.northwind-labs.dev/sse', remoteHeaders: { Authorization: 'Bearer ${DOCS_MCP_TOKEN}' },
      status: 'active', createdAt: ago(11 * DAY), updatedAt: ago(11 * DAY),
    },
    {
      id: 'demo-mcp-04', projectId: P.atlas, source: 'composio', toolkitSlug: 'linear',
      userId: `mc-proj-${P.atlas}`, connectedAccountId: 'ca_demo_atlas_linear', status: 'error',
      error: 'Connection token expired — reconnect required.', createdAt: ago(25 * DAY), updatedAt: ago(20 * HOUR),
    },
  ]);

  // ── Workflows (graphs + run history) ──────────────────────────────────────────────
  console.log('• Seeding workflows…');
  const digestGraph = {
    nodes: [
      { id: 't1', type: 'trigger' as const, position: { x: 0, y: 120 }, data: { schedule: { cron: '0 9 * * 1', timezone: 'America/New_York' } } },
      { id: 'a1', type: 'agent' as const, position: { x: 260, y: 120 }, data: { prompt: 'Draft this week’s Dispatch newsletter from the merged changelog.', profileSlug: 'builder' } },
      { id: 'g1', type: 'gate' as const, position: { x: 560, y: 120 }, data: { message: 'Approve the newsletter draft before it sends.' } },
      { id: 'i1', type: 'integration' as const, position: { x: 820, y: 120 }, data: { toolkit: 'slack', action: 'SLACK_SEND_MESSAGE', arguments: { channel: '#announce', text: '📣 New issue is live: {{a1.output.title}}' } } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'g1' },
      { id: 'e3', source: 'g1', target: 'i1' },
    ],
  };
  const triageGraph = {
    nodes: [
      { id: 't1', type: 'trigger' as const, position: { x: 0, y: 160 }, data: { event: { source: 'github', types: ['issues'] } } },
      { id: 'a1', type: 'agent' as const, position: { x: 250, y: 160 }, data: { prompt: 'Classify the GitHub issue {{trigger.output.issue.title}} by severity.', responseSchema: { type: 'object', properties: { severity: { type: 'string' } } } } },
      { id: 'b1', type: 'branch' as const, position: { x: 520, y: 160 }, data: { cases: [{ name: 'high', when: { left: '{{a1.output.severity}}', op: 'eq', right: 'high' } }] } },
      { id: 'i1', type: 'integration' as const, position: { x: 800, y: 60 }, data: { toolkit: 'linear', action: 'LINEAR_CREATE_ISSUE', arguments: { title: '{{trigger.output.issue.title}}', priority: 1 } } },
      { id: 'a2', type: 'agent' as const, position: { x: 800, y: 280 }, data: { prompt: 'Post a triage comment acknowledging the issue.' } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'b1' },
      { id: 'e3', source: 'b1', target: 'i1', sourceHandle: 'high', label: 'high' },
      { id: 'e4', source: 'b1', target: 'a2', sourceHandle: 'else', label: 'else' },
    ],
  };

  await db.insert(workflows).values([
    {
      id: 'demo-wf-digest', projectId: P.dispatch, slug: 'weekly-digest', name: 'Weekly Digest',
      description: 'Draft the Monday newsletter, gate on human approval, then announce in Slack.',
      status: 'active', graph: digestGraph, version: 4, createdAt: ago(18 * DAY), updatedAt: ago(2 * DAY),
    },
    {
      id: 'demo-wf-triage', projectId: P.habitcraft, slug: 'bug-triage', name: 'Bug Triage',
      description: 'Classify inbound GitHub issues and route high-severity ones to Linear.',
      status: 'active', graph: triageGraph, version: 7, createdAt: ago(24 * DAY), updatedAt: ago(9 * HOUR),
    },
  ]);

  // Extra runs backing the workflow agent steps.
  await db.insert(runs).values([
    { id: 'demo-run-wf1a', agentLabel: 'claude-code', projectId: P.dispatch, title: 'Weekly Digest · draft', status: 'completed', source: 'cron', model: 'opus', tokensIn: 72_000, tokensOut: 9_800, cacheReadTokens: 300_000, cacheWriteTokens: 40_000, costMicros: 188_000, startedAt: ago(7 * DAY), endedAt: ago(7 * DAY - 6 * MIN), lastHeartbeatAt: ago(7 * DAY - 6 * MIN) },
    { id: 'demo-run-wf1b', agentLabel: 'claude-code', projectId: P.dispatch, title: 'Weekly Digest · draft', status: 'completed', source: 'cron', model: 'opus', tokensIn: 69_500, tokensOut: 9_100, cacheReadTokens: 290_000, cacheWriteTokens: 38_000, costMicros: 176_000, startedAt: ago(20 * HOUR), endedAt: ago(20 * HOUR - 5 * MIN), lastHeartbeatAt: ago(20 * HOUR - 5 * MIN) },
    { id: 'demo-run-wf2c', agentLabel: 'claude-code', projectId: P.habitcraft, title: 'Bug Triage · classify', status: 'completed', source: 'event', model: 'opus', tokensIn: 41_000, tokensOut: 3_200, cacheReadTokens: 150_000, cacheWriteTokens: 20_000, costMicros: 96_000, startedAt: ago(9 * HOUR), endedAt: ago(9 * HOUR - 3 * MIN), lastHeartbeatAt: ago(9 * HOUR - 3 * MIN) },
  ]);

  console.log('• Seeding workflow runs + steps…');
  await db.insert(workflowRuns).values([
    { id: 'demo-wfr-1', workflowId: 'demo-wf-digest', status: 'completed', trigger: 'cron', graphSnapshot: digestGraph, startedAt: ago(7 * DAY), endedAt: ago(7 * DAY - 12 * MIN), lastHeartbeatAt: ago(7 * DAY - 12 * MIN) },
    { id: 'demo-wfr-2', workflowId: 'demo-wf-digest', status: 'paused', trigger: 'cron', graphSnapshot: digestGraph, startedAt: ago(20 * HOUR), lastHeartbeatAt: ago(20 * HOUR - 5 * MIN) },
    { id: 'demo-wfr-3', workflowId: 'demo-wf-triage', status: 'completed', trigger: 'event', graphSnapshot: triageGraph, context: { issue: { title: 'Crash when opening settings on Android 14' } }, startedAt: ago(9 * HOUR), endedAt: ago(9 * HOUR - 4 * MIN), lastHeartbeatAt: ago(9 * HOUR - 4 * MIN) },
  ]);
  await db.insert(workflowStepRuns).values([
    // Completed digest run.
    { id: 'demo-wsr-1', workflowRunId: 'demo-wfr-1', nodeId: 't1', status: 'completed', startedAt: ago(7 * DAY), endedAt: ago(7 * DAY) },
    { id: 'demo-wsr-2', workflowRunId: 'demo-wfr-1', nodeId: 'a1', status: 'completed', runId: 'demo-run-wf1a', output: { title: 'Ship streaks, smarter sending' }, startedAt: ago(7 * DAY), endedAt: ago(7 * DAY - 6 * MIN) },
    { id: 'demo-wsr-3', workflowRunId: 'demo-wfr-1', nodeId: 'g1', status: 'completed', output: { decision: 'approved', by: 'joe@northwind-labs.dev' }, startedAt: ago(7 * DAY - 6 * MIN), endedAt: ago(7 * DAY - 11 * MIN) },
    { id: 'demo-wsr-4', workflowRunId: 'demo-wfr-1', nodeId: 'i1', status: 'completed', output: { ok: true }, startedAt: ago(7 * DAY - 11 * MIN), endedAt: ago(7 * DAY - 12 * MIN) },
    // Paused digest run — awaiting approval at the gate.
    { id: 'demo-wsr-5', workflowRunId: 'demo-wfr-2', nodeId: 't1', status: 'completed', startedAt: ago(20 * HOUR), endedAt: ago(20 * HOUR) },
    { id: 'demo-wsr-6', workflowRunId: 'demo-wfr-2', nodeId: 'a1', status: 'completed', runId: 'demo-run-wf1b', output: { title: 'A calmer inbox' }, startedAt: ago(20 * HOUR), endedAt: ago(20 * HOUR - 5 * MIN) },
    { id: 'demo-wsr-7', workflowRunId: 'demo-wfr-2', nodeId: 'g1', status: 'running', startedAt: ago(20 * HOUR - 5 * MIN) },
    { id: 'demo-wsr-8', workflowRunId: 'demo-wfr-2', nodeId: 'i1', status: 'pending' },
    // Completed triage run — high path taken, else branch skipped.
    { id: 'demo-wsr-9', workflowRunId: 'demo-wfr-3', nodeId: 't1', status: 'completed', startedAt: ago(9 * HOUR), endedAt: ago(9 * HOUR) },
    { id: 'demo-wsr-10', workflowRunId: 'demo-wfr-3', nodeId: 'a1', status: 'completed', runId: 'demo-run-wf2c', output: { severity: 'high' }, startedAt: ago(9 * HOUR), endedAt: ago(9 * HOUR - 3 * MIN) },
    { id: 'demo-wsr-11', workflowRunId: 'demo-wfr-3', nodeId: 'b1', status: 'completed', output: { case: 'high' }, startedAt: ago(9 * HOUR - 3 * MIN), endedAt: ago(9 * HOUR - 3 * MIN) },
    { id: 'demo-wsr-12', workflowRunId: 'demo-wfr-3', nodeId: 'i1', status: 'completed', output: { issueId: 'NOR-482' }, startedAt: ago(9 * HOUR - 3 * MIN), endedAt: ago(9 * HOUR - 4 * MIN) },
    { id: 'demo-wsr-13', workflowRunId: 'demo-wfr-3', nodeId: 'a2', status: 'skipped' },
  ]);

  // ── Summary ───────────────────────────────────────────────────────────────────────
  const count = async (t: string) => {
    const res = (await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown;
    const rows = Array.isArray(res) ? res : (res as { rows?: Array<{ n: number }> }).rows;
    return rows?.[0]?.n ?? '?';
  };
  console.log('\n✓ Demo seed complete:');
  for (const t of ['projects', 'tasks', 'runs', 'events', 'agent_profiles', 'mcp_connections', 'workflows', 'workflow_runs', 'workflow_step_runs']) {
    console.log(`   ${t.padEnd(20)} ${await count(t)}`);
  }
}

main().catch((e) => {
  console.error('[seed-demo]', e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
