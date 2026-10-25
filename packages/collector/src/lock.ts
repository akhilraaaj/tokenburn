// One sync at a time per state directory (scheduled run, manual `sync`, `watch` and `setup` can overlap).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.ts';

const lockFile = () => path.join(stateDir(), 'sync.lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock, or returns null if another live tokenburn process holds it. Stale locks are reclaimed. */
export function acquireLock(): (() => void) | null {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile(), String(process.pid), { flag: 'wx', mode: 0o600 });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          if (fs.readFileSync(lockFile(), 'utf8') === String(process.pid)) fs.rmSync(lockFile());
        } catch {}
      };
      process.once('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lockFile(), 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) return null;
      fs.rmSync(lockFile(), { force: true }); // holder crashed: reclaim
    }
  }
  return null;
}

/** Runs `fn` under the lock; throws a friendly error if another sync is running. */
export async function withLock<T>(fn: () => Promise<T>, onBusy: () => T): Promise<T> {
  const release = acquireLock();
  if (!release) return onBusy();
  try {
    return await fn();
  } finally {
    release();
  }
}
