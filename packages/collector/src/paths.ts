import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateDir(): string {
  return process.env.TOKENBURN_HOME || path.join(os.homedir(), '.tokenburn');
}

/** Existing directories from `candidates`, deduped by real path, in order. */
export function existingDirs(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter((d) => {
    let real: string;
    try {
      real = fs.realpathSync(d);
      if (!fs.statSync(real).isDirectory()) return false;
    } catch {
      return false;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

export function listFiles(root: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(root);
  return out;
}
