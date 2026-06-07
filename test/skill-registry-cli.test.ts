// ABOUTME: Integration tests for `mc skill search` and `mc skill add` against a LOCAL mock server (skills.sh
// ABOUTME: /api/search + GitHub repo/tree/raw), with installs written to a tmp MC_CLAUDE_HOME. Runs the real
// ABOUTME: CLI via tsx. Proves the JSON envelope, the installed flag, validation exits, no-DB operation, and a
// ABOUTME: full end-to-end install. No real network, no DB.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

const SKILL_MD = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n\nbody\n`;

// Registry search payload + the GitHub repo content the install path will fetch.
const SEARCH = {
  query: 'react',
  skills: [
    { id: 'acme/pack/alpha-skill', skillId: 'alpha-skill', name: 'Alpha', installs: 1000, source: 'acme/pack' },
    { id: 'acme/pack/beta-skill', skillId: 'beta-skill', name: 'Beta', installs: 50, source: 'acme/pack' },
  ],
  count: 2,
};
const TREE = {
  truncated: false,
  tree: [
    { path: 'skills/alpha-skill/SKILL.md', type: 'blob' },
    { path: 'skills/alpha-skill/notes.md', type: 'blob' },
  ],
};
const RAW: Record<string, string> = {
  'acme/pack/main/skills/alpha-skill/SKILL.md': SKILL_MD('alpha-skill'),
  'acme/pack/main/skills/alpha-skill/notes.md': '# notes\n',
};

let server: Server;
let base: string;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const p = url.pathname;
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (p === '/api/search') return send(200, SEARCH);
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return send(200, { default_branch: 'main' });
    if (/\/git\/trees\//.test(p)) return send(200, TREE);
    if (p.startsWith('/raw/')) {
      const key = p.slice('/raw/'.length);
      return key in RAW ? send(200, RAW[key]) : send(404, 'nf');
    }
    return send(404, 'unhandled');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://localhost:${addr.port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-skill-cli-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run the mc CLI asynchronously (spawn, not spawnSync) so the in-process mock server keeps serving the child.
 *  Returns { stdout, status }; never rejects on a non-zero exit. */
function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ stdout: string; status: number }> {
  const env = { ...process.env, MC_CLAUDE_HOME: home, SKILLS_API_URL: base, MC_GITHUB_API_URL: base, MC_GITHUB_RAW_URL: `${base}/raw`, ...extraEnv };
  delete (env as Record<string, string>).AGENT_DATABASE_URL; // prove these commands never gate on the DB
  return new Promise((resolve) => {
    const child = spawn(tsxBin, ['cli/index.ts', ...args], { env });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve({ stdout, status: code ?? 1 }));
  });
}

describe('mc skill search', () => {
  it('returns registry results as a JSON envelope, sorted, with an installed flag', async () => {
    // Plant beta-skill locally so its installed flag is true.
    mkdirSync(join(home, 'skills', 'beta-skill'), { recursive: true });
    writeFileSync(join(home, 'skills', 'beta-skill', 'SKILL.md'), SKILL_MD('beta-skill'));

    const { stdout, status } = await runCli(['skill', 'search', 'react', '--json']);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.command).toBe('skill search');
    expect(env.data.count).toBe(2);
    expect(env.data.items[0]).toMatchObject({ slug: 'alpha-skill', installed: false });
    expect(env.data.items.find((s: { slug: string }) => s.slug === 'beta-skill').installed).toBe(true);
  }, 60000);

  it('rejects a query shorter than 2 chars with a VALIDATION envelope (exit 2)', async () => {
    const { stdout, status } = await runCli(['skill', 'search', 'a', '--json']);
    expect(status).toBe(2);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('VALIDATION');
  }, 60000);

  it('maps a registry HTTP failure to a REGISTRY envelope (not DB)', async () => {
    const { stdout, status } = await runCli(['skill', 'search', 'react', '--json'], { SKILLS_API_URL: `${base}/nope` });
    expect(status).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe('REGISTRY');
  }, 60000);
});

describe('mc skill add', () => {
  it('installs a registry skill into ~/.claude/skills from GitHub content (no DB)', async () => {
    const { stdout, status } = await runCli(['skill', 'add', 'acme/pack@alpha-skill', '--json']);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({ slug: 'alpha-skill', fileCount: 2, installed: true });
    const dest = join(home, 'skills', 'alpha-skill');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('name: alpha-skill');
    expect(existsSync(join(dest, 'notes.md'))).toBe(true);
  }, 60000);

  it('rejects an unparseable target with a VALIDATION envelope', async () => {
    const { stdout, status } = await runCli(['skill', 'add', 'not-a-target', '--json']);
    expect(status).toBe(2);
    expect(JSON.parse(stdout).error.code).toBe('VALIDATION');
  }, 60000);

  it('refuses to overwrite an installed skill without --force (CONFLICT), then succeeds with --force', async () => {
    expect((await runCli(['skill', 'add', 'acme/pack@alpha-skill', '--json'])).status).toBe(0);
    const conflict = await runCli(['skill', 'add', 'acme/pack@alpha-skill', '--json']);
    expect(conflict.status).toBe(1);
    expect(JSON.parse(conflict.stdout).error.code).toBe('CONFLICT');
    expect((await runCli(['skill', 'add', 'acme/pack@alpha-skill', '--force', '--json'])).status).toBe(0);
  }, 60000);
});
