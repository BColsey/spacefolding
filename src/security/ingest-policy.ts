import { basename, dirname, join, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

/**
 * Ingest-root allowlist.
 *
 * The MCP ingest tools (`ingest_project`, `ingest_directory`) and the CLI ingest
 * commands accept a filesystem path from a caller. Left unchecked, an agent (or
 * injected context) could point them at an arbitrary absolute path — e.g.
 * `~/.ssh` — and exfiltrate its contents into the context store. This policy is
 * the trust boundary: it confines ingest paths to an explicit set of roots.
 *
 * Allowed roots, in order:
 *   1. The process working directory (always allowed — the frictionless local
 *      default is "ingest the repo you launched from").
 *   2. Any path listed in the `SF_INGEST_ROOTS` environment variable
 *      (colon-separated; relative entries resolve against the cwd).
 *
 * The check resolves symlinks (`realpath`) and rejects `..` traversal, so a link
 * or relative path that escapes every root is denied even when its lexical form
 * sits inside one. The orchestrator remains a trusted internal API; this guard
 * lives at the CLI/MCP entry points where untrusted input arrives.
 */
const ENV_INGEST_ROOTS = 'SF_INGEST_ROOTS';

/** Resolve `p` to a canonical path, following symlinks where the path exists. */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // `p` (or a tail component) does not exist yet. Walk up to the deepest
    // existing ancestor, realpath it (collapsing any symlink such as /tmp on
    // macOS), then re-append the non-existent tail so the result stays
    // consistent with how roots are canonicalized.
    let dir = p;
    const tail: string[] = [];
    while (dir.length > 0 && dir !== sep && !existsSync(dir)) {
      tail.unshift(basename(dir));
      dir = dirname(dir);
    }
    try {
      const realAncestor = realpathSync(dir);
      return tail.length === 0 ? realAncestor : join(realAncestor, ...tail);
    } catch {
      return resolve(p);
    }
  }
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export interface IngestPolicy {
  /** Canonicalized allowed roots, for diagnostics/logging. */
  readonly roots: readonly string[];
  /** Returns undefined when the path is allowed, otherwise a denial reason. */
  assertAllowed(inputPath: string): string | undefined;
  /** Convenience boolean form of {@link assertAllowed}. */
  isAllowed(inputPath: string): boolean;
}

export interface CreateIngestPolicyOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function createIngestPolicy(options: CreateIngestPolicyOptions = {}): IngestPolicy {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const roots = new Set<string>();
  roots.add(canonicalize(cwd));
  const raw = env[ENV_INGEST_ROOTS];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    for (const entry of raw.split(/[:;]/)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      roots.add(canonicalize(resolve(cwd, trimmed)));
    }
  }
  const rootList = [...roots];

  const assertAllowed = (inputPath: string): string | undefined => {
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      return 'path must be a non-empty string';
    }
    const target = canonicalize(resolve(cwd, inputPath));
    for (const root of rootList) {
      if (isWithin(target, root)) return undefined;
    }
    return (
      `Refused: ingest path "${inputPath}" resolves outside the allowed roots. ` +
      `Set SF_INGEST_ROOTS (colon-separated absolute paths) to permit it. ` +
      `Allowed roots: ${rootList.join(', ')}`
    );
  };

  return {
    roots: rootList,
    assertAllowed,
    isAllowed: (p) => assertAllowed(p) === undefined,
  };
}
