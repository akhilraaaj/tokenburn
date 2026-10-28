import { describe, expect, it } from 'vitest';
import { cleanUsername, pickUsername, signPending, verifyPending } from '../src/auth.ts';
import type { Env } from '../src/util.ts';

/** Just enough of D1 for pickUsername: answers its one `username IN (...)` query from a set of taken names. */
const fakeEnv = (taken: string[]) => {
  let queries = 0;
  const env = {
    DB: {
      prepare: () => ({
        bind: (...names: string[]) => ({
          all: async () => {
            queries++;
            return { results: names.filter((n) => taken.includes(n)).map((u) => ({ u })) };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, queries: () => queries };
};

describe('claimed usernames', () => {
  it('accepts only valid, unreserved names, case-insensitively', () => {
    expect(cleanUsername('  Akhil ')).toBe('akhil');
    expect(cleanUsername('ab')).toBeNull();
    expect(cleanUsername('-dash')).toBeNull();
    expect(cleanUsername('admin')).toBeNull();
    expect(cleanUsername(null)).toBeNull();
  });

  it('prefers the claimed name, then the GitHub login, then none, in one query', async () => {
    const free = fakeEnv([]);
    expect(await pickUsername(free.env, 'akhil', 'akhilraj')).toBe('akhil');
    expect(free.queries()).toBe(1);
    expect(await pickUsername(fakeEnv(['akhil']).env, 'akhil', 'akhilraj')).toBe('akhilraj');
    expect(await pickUsername(fakeEnv(['akhil', 'akhilraj']).env, 'akhil', 'akhilraj')).toBeNull();
    expect(await pickUsername(fakeEnv([]).env, null, 'AkhilRaj')).toBe('akhilraj');
    expect(await pickUsername(fakeEnv([]).env, null, 'x')).toBeNull(); // GitHub login too short to be a username
  });

  it('carries the claimed name in the signed sign-up token, never an invalid one', async () => {
    const secret = 'test-secret';
    expect(await verifyPending(secret, await signPending(secret, { id: 1, login: 'a', wanted: 'akhil' }))).toMatchObject({ wanted: 'akhil' });
    expect((await verifyPending(secret, await signPending(secret, { id: 1, login: 'a', wanted: 'admin' })))?.wanted).toBeUndefined();
    expect((await verifyPending(secret, await signPending(secret, { id: 1, login: 'a' })))?.wanted).toBeUndefined();
  });
});
