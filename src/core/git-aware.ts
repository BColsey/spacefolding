import { execSync } from 'node:child_process';
import type { GitChange } from '../types/index.js';

export function parseGitDiff(diffText: string): GitChange[] {
  const changes: GitChange[] = [];
  let current: GitChange | null = null;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      if (current) changes.push(current);
      const parts = line.split(' ');
      const filePath = parts[3]?.replace(/^b\//, '') ?? '';
      current = { filePath, changeType: 'modified', hunks: 0 };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('new file mode') || line.startsWith('--- /dev/null')) {
      current.changeType = 'added';
      continue;
    }

    if (line.startsWith('deleted file mode') || line.startsWith('+++ /dev/null')) {
      current.changeType = 'deleted';
      continue;
    }

    if (line.startsWith('+++ b/')) {
      current.filePath = line.slice(6);
      continue;
    }

    if (line.startsWith('@@')) {
      current.hunks += 1;
    }
  }

  if (current) changes.push(current);
  return changes.filter((change) => change.filePath.length > 0);
}

export function scoreGitChanges(filePath: string, changeType: string): number {
  void filePath;
  if (changeType === 'added') return 0.9;
  if (changeType === 'modified') return 0.7;
  if (changeType === 'deleted') return 0.3;
  return 0;
}

export async function getRecentGitChanges(repoPath: string): Promise<GitChange[]> {
  try {
    const output = execSync('git diff --name-status HEAD~1', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [status, filePath] = line.split(/\s+/, 2);
        return {
          filePath,
          changeType:
            status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
          hunks: 0,
        } satisfies GitChange;
      });
  } catch {
    return [];
  }
}
