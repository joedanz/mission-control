// ABOUTME: Guards the mc CLI's self-description: every registered commander leaf command must appear in
// ABOUTME: the SPEC catalog (and vice-versa), the ENUMS catalog must match its schema source-of-truth,
// ABOUTME: and the spend --group-by doc string must match SPEND_GROUP_BYS. Fails on drift so `mc spec`
// ABOUTME: (the agent's runtime discovery contract) can never silently lie about the command surface.

import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { program, SPEC, ENUMS } from '../cli/index';
import {
  CATEGORIES,
  STATUSES,
  ACCENTS,
  PRIORITIES,
  TASK_STATUSES,
  INTEGRATION_TYPES,
  INTEGRATION_STATUSES,
  RUN_STATUSES,
  RUN_SOURCES,
  EVENT_TYPES,
  EVENT_LEVELS,
  PROFILE_RUNTIMES,
  PERMISSION_MODES,
} from '../lib/db/schema';
import { SPEND_GROUP_BYS } from '../lib/constants';

/** Space-joined paths of every LEAF command (an action command with no subcommands), root name excluded.
 *  Mirrors how SPEC names a command ("project list", not the "project" group). 'help' is commander's. */
function leafPaths(cmd: Command, prefix: string[] = []): string[] {
  const subs = cmd.commands.filter((c) => c.name() !== 'help');
  if (subs.length === 0) return prefix.length ? [prefix.join(' ')] : [];
  return subs.flatMap((s) => leafPaths(s, [...prefix, s.name()]));
}

describe('spec-sync: mc spec catalog tracks the real CLI', () => {
  it('registered commands and SPEC are the same set (no missing, no extra)', () => {
    const registered = new Set(leafPaths(program));
    const spec = new Set<string>(SPEC.map((c) => c.name));
    const missingFromSpec = [...registered].filter((n) => !spec.has(n)).sort();
    const extraInSpec = [...spec].filter((n) => !registered.has(n)).sort();
    expect(missingFromSpec, 'registered commands absent from SPEC — add them to the SPEC catalog').toEqual([]);
    expect(extraInSpec, 'SPEC entries with no registered commander command — stale catalog entry').toEqual([]);
  });

  it('every SPEC entry has the required shape (name, readonly, summary)', () => {
    for (const c of SPEC) {
      expect(typeof c.name, `${c.name}: name must be a string`).toBe('string');
      expect(typeof c.readonly, `${c.name}: readonly must be a boolean`).toBe('boolean');
      expect(typeof c.summary, `${c.name}: summary must be a string`).toBe('string');
    }
  });

  it('ENUMS catalog matches its lib/db/schema source-of-truth', () => {
    expect(ENUMS.category).toEqual([...CATEGORIES]);
    expect(ENUMS.status).toEqual([...STATUSES]);
    expect(ENUMS.accent).toEqual([...ACCENTS]);
    expect(ENUMS.priority).toEqual([...PRIORITIES]);
    expect(ENUMS.taskStatus).toEqual([...TASK_STATUSES]);
    expect(ENUMS.integrationType).toEqual([...INTEGRATION_TYPES]);
    expect(ENUMS.integrationStatus).toEqual([...INTEGRATION_STATUSES]);
    expect(ENUMS.runStatus).toEqual([...RUN_STATUSES]);
    expect(ENUMS.runSource).toEqual([...RUN_SOURCES]);
    expect(ENUMS.eventType).toEqual([...EVENT_TYPES]);
    expect(ENUMS.eventLevel).toEqual([...EVENT_LEVELS]);
    expect(ENUMS.runtime).toEqual([...PROFILE_RUNTIMES]);
    expect(ENUMS.permissionMode).toEqual([...PERMISSION_MODES]);
  });

  it('spend --group-by doc string lists exactly SPEND_GROUP_BYS', () => {
    const spend = SPEC.find((c) => c.name === 'spend');
    const options: readonly string[] | undefined = spend && 'options' in spend ? spend.options : undefined;
    const groupBy = options?.find((o) => o.includes('--group-by'));
    expect(groupBy, 'spend should document a --group-by option').toBeDefined();
    expect(groupBy).toBe(`--group-by ${SPEND_GROUP_BYS.join('|')}`);
  });
});
