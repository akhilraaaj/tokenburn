import { useEffect, useState } from 'react';

/** Mirrors USERNAME_RE in apps/api/src/auth.ts, so obviously invalid names never cost a request. */
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;

export type UsernameCheck = { state: 'idle' | 'checking' | 'ok' | 'bad' | 'unknown'; reason?: string };

// One request per name per page load: in-flight lookups are shared (the hero and the closing call-to-action both
// ask), and settled answers are reused, so retyping or backspacing never asks again.
const inflight = new Map<string, Promise<UsernameCheck>>();
const settled = new Map<string, UsernameCheck>();

const FORMAT_HINT = 'Start with a letter or number; use a–z, 0–9, - or _';

/** Why a name can't be a username on its format alone (no request), or null if it could be. */
export function usernameFormatError(name: string): string | null {
  if (name.length < 3) return 'Use at least 3 characters';
  return USERNAME_RE.test(name) ? null : FORMAT_HINT;
}

/** Checks a name now, skipping the debounce (for submit); reuses a settled or in-flight answer. */
export function checkUsernameNow(name: string): Promise<UsernameCheck> {
  const bad = usernameFormatError(name);
  if (bad) return Promise.resolve({ state: 'bad', reason: bad });
  return Promise.resolve(settled.get(name) ?? lookup(name));
}

function lookup(name: string): Promise<UsernameCheck> {
  let p = inflight.get(name);
  if (!p) {
    p = fetch(`/api/username-available?name=${encodeURIComponent(name)}`)
      .then(async (res): Promise<UsernameCheck> => {
        if (!res.ok) return { state: 'unknown' }; // rate-limited or down: say nothing; sign-up re-checks anyway
        const r = (await res.json()) as { available: boolean; reason?: string };
        const out: UsernameCheck = r.available ? { state: 'ok' } : { state: 'bad', reason: r.reason };
        settled.set(name, out);
        return out;
      })
      .catch((): UsernameCheck => ({ state: 'unknown' }))
      .finally(() => inflight.delete(name));
    inflight.set(name, p);
  }
  return p;
}

/** Availability of a username as it's typed: checked once typing pauses, from memory when already known. */
export function useUsernameCheck(name: string, delayMs = 400): UsernameCheck {
  const [check, setCheck] = useState<UsernameCheck>({ state: 'idle' });
  useEffect(() => {
    if (name.length < 3) return setCheck({ state: 'idle' });
    if (!USERNAME_RE.test(name)) return setCheck({ state: 'bad', reason: FORMAT_HINT });
    const known = settled.get(name);
    if (known) return setCheck(known);
    setCheck({ state: 'checking' });
    let live = true;
    const t = setTimeout(() => lookup(name).then((r) => live && setCheck(r)), delayMs);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [name, delayMs]);
  return check;
}
