import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIngestPolicy } from '../src/security/ingest-policy.js';

describe('IngestPolicy (ingest-root allowlist)', () => {
  it('allows a path under the default cwd root', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-cwd-'));
    try {
      const policy = createIngestPolicy({ cwd: root, env: {} });
      expect(policy.assertAllowed(join(root, 'src', 'index.ts'))).toBeUndefined();
      expect(policy.isAllowed(join(root, 'src', 'index.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows the root directory itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-root-'));
    try {
      const policy = createIngestPolicy({ cwd: root, env: {} });
      expect(policy.assertAllowed(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies a path outside every allowed root', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-deny-'));
    const outside = mkdtempSync(join(tmpdir(), 'sf-policy-outside-'));
    try {
      const policy = createIngestPolicy({ cwd: root, env: {} });
      const reason = policy.assertAllowed(join(outside, 'id_rsa'));
      expect(reason).toBeDefined();
      expect(reason).toContain('outside the allowed roots');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not prefix-match a sibling whose name starts with a root name', () => {
    // root ".../workspace" must NOT permit ".../workspace-evil"
    const parent = mkdtempSync(join(tmpdir(), 'sf-policy-prefix-'));
    const root = join(parent, 'workspace');
    const evil = join(parent, 'workspace-evil');
    mkdirSync(root, { recursive: true });
    mkdirSync(evil, { recursive: true });
    try {
      const policy = createIngestPolicy({ cwd: root, env: {} });
      expect(policy.assertAllowed(join(evil, 'steal.ts'))).toBeDefined();
      expect(policy.assertAllowed(join(root, 'ok.ts'))).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects ".." traversal that escapes every allowed root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sf-policy-traversal-'));
    try {
      const policy = createIngestPolicy({ cwd, env: {} });
      const escapee = join(cwd, '..', '..', '..', 'etc');
      expect(policy.assertAllowed(escapee)).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a symlink whose realpath escapes every allowed root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sf-policy-symlink-cwd-'));
    const secret = mkdtempSync(join(tmpdir(), 'sf-policy-symlink-secret-'));
    const link = join(cwd, 'link-to-secret');
    symlinkSync(secret, link, 'dir');
    try {
      const policy = createIngestPolicy({ cwd, env: {} });
      // The link sits inside cwd by path, but its realpath is `secret` (outside) -> deny.
      expect(policy.assertAllowed(link)).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });

  it('honors multiple colon-separated SF_INGEST_ROOTS entries', () => {
    const a = mkdtempSync(join(tmpdir(), 'sf-policy-multi-a-'));
    const b = mkdtempSync(join(tmpdir(), 'sf-policy-multi-b-'));
    try {
      const policy = createIngestPolicy({ cwd: a, env: { SF_INGEST_ROOTS: `${a}:${b}` } });
      expect(policy.assertAllowed(join(a, 'x.ts'))).toBeUndefined();
      expect(policy.assertAllowed(join(b, 'y.ts'))).toBeUndefined();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('resolves a relative SF_INGEST_ROOTS entry against cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-rel-'));
    mkdirSync(join(root, 'sub'), { recursive: true });
    try {
      const policy = createIngestPolicy({ cwd: root, env: { SF_INGEST_ROOTS: './sub' } });
      expect(policy.assertAllowed(join(root, 'sub', 'a.ts'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps cwd as an allowed root even when SF_INGEST_ROOTS is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-cwdkeep-'));
    const other = mkdtempSync(join(tmpdir(), 'sf-policy-cwdkeep-other-'));
    try {
      const policy = createIngestPolicy({ cwd: root, env: { SF_INGEST_ROOTS: other } });
      expect(policy.assertAllowed(join(root, 'in-cwd.ts'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('exposes the resolved roots for diagnostics', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-policy-roots-'));
    try {
      const policy = createIngestPolicy({ cwd: root, env: {} });
      expect(policy.roots).toContain(realpathSync(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
