import { describe, expect, it } from 'vitest';
import { signPending, verifyPending } from '../src/auth.ts';

describe('pending sign-up token', () => {
  const secret = 'test-secret';
  it('round-trips the GitHub identity', async () => {
    const t = await signPending(secret, { id: 109157980, login: 'akhilraaaj' });
    expect(await verifyPending(secret, t)).toMatchObject({ id: 109157980, login: 'akhilraaaj' });
  });
  it('rejects edited payloads, wrong secrets, garbage and missing tokens', async () => {
    const t = await signPending(secret, { id: 1, login: 'a' });
    const [, sig] = t.split('.');
    const forged = btoa(JSON.stringify({ id: 2, login: 'victim', exp: Date.now() + 60_000 })).replace(/=+$/, '') + '.' + sig;
    expect(await verifyPending(secret, forged)).toBeNull();
    expect(await verifyPending('other-secret', t)).toBeNull();
    expect(await verifyPending(secret, 'not-a-token')).toBeNull();
    expect(await verifyPending(secret, null)).toBeNull();
    expect(await verifyPending('', t)).toBeNull();
  });
  it('expires after 10 minutes', async () => {
    const t = await signPending(secret, { id: 1, login: 'a' }, Date.now() - 11 * 60_000);
    expect(await verifyPending(secret, t)).toBeNull();
  });
});
