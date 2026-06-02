// ABOUTME: Slice-5 pure scheduler coverage — isDue (interval + cron + never-run) and the check-in prompt
// ABOUTME: assembly. No DB / no spawn: the due-math and prompt shape are the testable core the scheduler calls.

import { describe, it, expect } from 'vitest';
import { isDue, nextCheckInAt, buildCheckInPrompt } from '../daemon/schedule';

const at = (iso: string) => new Date(iso);

describe('isDue (pure)', () => {
  it('a profile that has never checked in is due immediately', () => {
    expect(isDue({ scheduleIntervalSec: 900, scheduleCron: null, lastCheckInAt: null }, at('2026-06-01T00:00:00Z'))).toBe(true);
    expect(isDue({ scheduleIntervalSec: null, scheduleCron: '0 9 * * *', lastCheckInAt: null }, at('2026-06-01T00:00:00Z'))).toBe(true);
  });

  it('interval mode: due once intervalSec has elapsed', () => {
    const last = at('2026-06-01T00:00:00Z');
    const p = { scheduleIntervalSec: 900, scheduleCron: null, lastCheckInAt: last }; // 15 min
    expect(isDue(p, at('2026-06-01T00:10:00Z'))).toBe(false); // 10 min < 15
    expect(isDue(p, at('2026-06-01T00:15:00Z'))).toBe(true); // exactly 15 min
    expect(isDue(p, at('2026-06-01T01:00:00Z'))).toBe(true); // well past
  });

  it('cron mode: due once the next fire after the last check-in has arrived', () => {
    // hourly on the hour; last check-in at 00:30 → next fire is 01:00
    const p = { scheduleIntervalSec: null, scheduleCron: '0 * * * *', lastCheckInAt: at('2026-06-01T00:30:00Z') };
    expect(isDue(p, at('2026-06-01T00:45:00Z'))).toBe(false); // before 01:00
    expect(isDue(p, at('2026-06-01T01:00:00Z'))).toBe(true); // at 01:00
  });

  it('cron takes precedence over interval when both are set', () => {
    // interval would say "due" (1s elapsed long ago) but cron (next year) says no
    const p = { scheduleIntervalSec: 1, scheduleCron: '0 0 1 1 *', lastCheckInAt: at('2026-06-01T00:00:00Z') };
    expect(isDue(p, at('2026-06-01T12:00:00Z'))).toBe(false);
  });

  it('cron is evaluated in scheduleTimezone — same expr fires at a different instant per zone', () => {
    // "9am daily", last check-in just after midnight UTC. In New York (EDT, UTC-4 on 2026-06-01) 9am EDT
    // is 13:00 UTC; in UTC it is 09:00 UTC. The clock at 09:30 UTC is therefore past the UTC fire but not
    // the NY one — proving the zone is actually applied (not silently resolved against process-local time).
    const last = at('2026-06-01T00:00:00Z');
    const ny = { scheduleIntervalSec: null, scheduleCron: '0 9 * * *', scheduleTimezone: 'America/New_York', lastCheckInAt: last };
    const utc = { scheduleIntervalSec: null, scheduleCron: '0 9 * * *', scheduleTimezone: 'UTC', lastCheckInAt: last };
    expect(isDue(utc, at('2026-06-01T09:30:00Z'))).toBe(true); // past 09:00 UTC
    expect(isDue(ny, at('2026-06-01T09:30:00Z'))).toBe(false); // before 13:00 UTC (= 09:00 EDT)
    expect(isDue(ny, at('2026-06-01T13:30:00Z'))).toBe(true); // past 13:00 UTC
  });

  it('no trigger configured → never due', () => {
    expect(isDue({ scheduleIntervalSec: null, scheduleCron: null, lastCheckInAt: at('2026-06-01T00:00:00Z') }, at('2030-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('nextCheckInAt (pure)', () => {
  const now = at('2026-06-01T12:00:00Z');

  it('a profile that has never checked in is due now (returns `from`)', () => {
    expect(nextCheckInAt({ scheduleIntervalSec: 900, scheduleCron: null, lastCheckInAt: null }, now)).toEqual(now);
  });

  it('interval mode: lastCheckInAt + intervalSec', () => {
    const p = { scheduleIntervalSec: 900, scheduleCron: null, lastCheckInAt: at('2026-06-01T11:50:00Z') };
    expect(nextCheckInAt(p, now)).toEqual(at('2026-06-01T12:05:00Z'));
  });

  it('cron mode: the next fire after the last check-in', () => {
    const p = { scheduleIntervalSec: null, scheduleCron: '0 * * * *', lastCheckInAt: at('2026-06-01T11:30:00Z') };
    expect(nextCheckInAt(p, now)).toEqual(at('2026-06-01T12:00:00Z'));
  });

  it('no trigger configured → null', () => {
    expect(nextCheckInAt({ scheduleIntervalSec: null, scheduleCron: null, lastCheckInAt: at('2026-06-01T00:00:00Z') }, now)).toBeNull();
  });

  it('an unparseable cron → null (never crashes the caller)', () => {
    expect(nextCheckInAt({ scheduleIntervalSec: null, scheduleCron: 'not-a-cron', lastCheckInAt: at('2026-06-01T00:00:00Z') }, now)).toBeNull();
  });

  it('a bad timezone → null rather than throwing (defends a value that slipped past validation)', () => {
    const p = { scheduleIntervalSec: null, scheduleCron: '0 9 * * *', scheduleTimezone: 'Not/AZone', lastCheckInAt: at('2026-06-01T00:00:00Z') };
    expect(nextCheckInAt(p, now)).toBeNull();
  });

  it('cron next-fire is computed in scheduleTimezone', () => {
    // last check-in just after midnight UTC; next "9am" in New York (EDT) is 13:00 UTC.
    const p = { scheduleIntervalSec: null, scheduleCron: '0 9 * * *', scheduleTimezone: 'America/New_York', lastCheckInAt: at('2026-06-01T00:00:00Z') };
    expect(nextCheckInAt(p, now)).toEqual(at('2026-06-01T13:00:00Z'));
  });
});

describe('buildCheckInPrompt (pure)', () => {
  const project = { slug: 'acme', name: 'Acme' };

  it('embeds the mission and frames the pre-claimed task (auto-done on completion, no self-claim of IT)', () => {
    const out = buildCheckInPrompt({ checkInPrompt: 'Triage new issues.' }, project, { label: 'fix login', notes: 'broken on Safari' }, 1);
    expect(out).toContain('Triage new issues.'); // mission
    expect(out).toContain('fix login'); // claimed task label
    expect(out).toContain('broken on Safari'); // notes
    expect(out).toContain('Acme'); // project name
    expect(out).toMatch(/claimed/i); // it's already claimed to this run
    expect(out).toMatch(/marked done|complete/i); // run completion auto-finishes it
  });

  it('with maxTasks=1 does NOT invite draining more (no self-claim instructions at all)', () => {
    const out = buildCheckInPrompt({ checkInPrompt: 'Just the one.' }, project, { label: 'solo task' }, 1);
    expect(out).toContain('solo task');
    expect(out).not.toContain('mc task claim'); // budget is 1 → the agent never claims anything
    expect(out).not.toMatch(/keep draining|up to 1 tasks/i);
  });

  it('with maxTasks>1 invites the agent to drain more via the documented claim→done→claim-next loop', () => {
    const out = buildCheckInPrompt({ checkInPrompt: 'Drain the queue.' }, project, { label: 'fix login' }, 5);
    expect(out).toContain('Drain the queue.'); // mission
    expect(out).toContain('fix login'); // the pre-claimed task
    expect(out).toMatch(/up to 5 tasks/i); // the cap is surfaced to the agent
    expect(out).toContain('mc task next --project acme'); // how to find the next one
    expect(out).toContain('mc task claim <id> --run $MC_RUN_ID'); // how to claim it (with the run binding)
    expect(out).toContain('mc task set-status <id> done'); // and how to complete it
    expect(out).toMatch(/mark the current task done before you can claim the next/i); // the cap constraint, stated
    expect(out).toMatch(/no output redirection or pipes/i); // friction guard: redirects defeat the Bash(mc:*) allow-list
  });

  it('falls back to a default mission when no task was claimed (and never invites draining)', () => {
    const out = buildCheckInPrompt({ checkInPrompt: null }, project, null, 5);
    expect(out).toContain('review its state'); // default mission
    expect(out).toMatch(/no task/i);
    expect(out).not.toContain('mc task claim'); // nothing queued → nothing to drain
  });
});
