import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { PROVIDER_LABELS, type ProfileSettings, type WebDevice, type WebUser } from '../../../../packages/shared/src/index.ts';
import { useSession } from '../components/Layout.tsx';
import { Card, Loading, Notice } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { timeAgo } from '../lib/format.ts';

const FLAGS: [keyof ProfileSettings, string, string][] = [
  ['show_providers', 'Tools', 'Which tools you use and their data source'],
  ['show_models', 'Models', 'Which models you use, with request counts'],
  ['show_token_totals', 'Token totals', 'Input, output, cache and total tokens'],
  ['show_daily_trend', 'Daily trend', 'Day-by-day activity chart (requests, or tokens if token totals are on)'],
  ['show_sessions', 'Session count', 'Number of sessions'],
  ['show_streaks', 'Streaks & best day', 'Current and longest streak, best day'],
  ['show_costs', 'Estimated cost', 'API list-price estimate (not your bill)'],
];

interface SettingsData { user: WebUser; profile: ProfileSettings; devices: WebDevice[]; origin: string }

export function Settings() {
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<SettingsData | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [username, setUsername] = useState('');
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [provider, setProvider] = useState('all');
  const [confirm, setConfirm] = useState('');

  const load = async () => {
    const d = await api<SettingsData>('GET', '/api/web/settings');
    setData(d);
    setUsername(d.user.username ?? '');
    setProfile(d.profile);
  };
  useEffect(() => { if (user) void load(); }, [user]);

  /** Runs an action and shows its outcome in the banner. */
  const run = (fn: () => Promise<string | void>) => async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      const text = await fn();
      if (text) setMsg({ text });
    } catch (err) {
      setMsg({ text: err instanceof ApiError ? err.message : String(err), error: true });
    }
    window.scrollTo(0, 0);
  };

  if (loading) return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (!data || !profile) return <Loading />;

  const flag = (k: keyof ProfileSettings) => !!profile[k];
  const toggle = (k: keyof ProfileSettings) => setProfile({ ...profile, [k]: !profile[k] });

  return (
    <>
      {msg && <Notice>{msg.error ? '⚠ ' : ''}{msg.text}</Notice>}
      <Card>
        <h2 className="font-semibold">Username</h2>
        <form className="flex gap-3 items-center flex-wrap" onSubmit={run(async () => {
          const r = await api<{ username: string }>('PUT', '/api/web/username', { username });
          await refresh();
          await load();
          return `Username set to ${r.username}.`;
        })}>
          <span className="text-muted">{new URL(data.origin).host}/@</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[a-z0-9][a-z0-9_\-]{2,29}" aria-label="Username" />
          <button className="btn" type="submit">Save</button>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold">Public profile</h2>
        <p className="text-[0.85rem] text-secondary">Private by default. When public, <code>/@{data.user.username ?? 'username'}</code> shows only what you tick.
          Device names, paths, session contents and emails are never shown.</p>
        <form className="grid gap-2.5" onSubmit={run(async () => {
          const body = Object.fromEntries(FLAGS.map(([k]) => [k, flag(k)]));
          const p = await api<ProfileSettings>('PATCH', '/api/web/profile', { ...body, is_public: flag('is_public'), display_name: profile.display_name ?? '' });
          setProfile(p);
          return p.is_public ? 'Saved. Your profile is public.' : 'Saved. Your profile is private.';
        })}>
          <label className="flex gap-2 items-start">
            <input type="checkbox" className="mt-1" checked={flag('is_public')} disabled={!data.user.username} onChange={() => toggle('is_public')} />
            <span><b>Make my profile public</b>{!data.user.username && <span className="text-muted"> (set a username first)</span>}</span>
          </label>
          <label className="grid gap-1 text-[0.92rem]">Display name
            <input className="input" maxLength={60} value={profile.display_name ?? ''} onChange={(e) => setProfile({ ...profile, display_name: e.target.value })} />
          </label>
          {FLAGS.map(([k, label, help]) => (
            <label key={k} className="flex gap-2 items-start text-[0.92rem]">
              <input type="checkbox" className="mt-1" checked={flag(k)} onChange={() => toggle(k)} />
              <span>{label} <span className="text-muted text-[0.85rem]">{help}</span></span>
            </label>
          ))}
          <div className="flex gap-3 items-center">
            <button className="btn btn-primary" type="submit">Save profile</button>
            {data.user.username && <Link to={`/@${data.user.username}`}>View profile</Link>}
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold">Machines</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Device</th><th>Connected</th><th>Last sync</th><th /></tr></thead>
            <tbody>
              {data.devices.length ? data.devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.created_at.slice(0, 10)}</td>
                  <td>{timeAgo(d.last_sync_at)}</td>
                  <td className="r">
                    <button className="btn btn-danger" onClick={run(async () => {
                      if (!window.confirm(`Disconnect ${d.name} and delete the usage it uploaded?`)) return;
                      await api('DELETE', `/api/web/devices/${d.id}`);
                      await load();
                      return 'Machine disconnected and its uploaded usage deleted.';
                    })}>Disconnect and delete its data</button>
                  </td>
                </tr>
              )) : <tr><td colSpan={4} className="text-muted">No machines yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">Data</h2>
        <form className="flex gap-3 items-center flex-wrap" onSubmit={run(async () => {
          if (!window.confirm('Permanently delete this uploaded usage?')) return;
          await api('DELETE', `/api/web/data?provider=${provider}`);
          return 'Uploaded usage deleted.';
        })}>
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Tool">
            <option value="all">All tools</option>
            {Object.entries(PROVIDER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-danger" type="submit">Delete uploaded usage</button>
        </form>
        <p className="text-[0.85rem] text-muted">Connected machines upload again on their next sync. Disconnect them too (above) to stop that.</p>
      </Card>

      <Card>
        <h2 className="font-semibold">Delete account</h2>
        <form className="flex gap-3 items-center flex-wrap" onSubmit={run(async () => {
          await api('DELETE', '/api/web/account', { confirm });
          await refresh();
          navigate('/');
        })}>
          <input className="input" placeholder='Type "delete my account"' value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          <button className="btn btn-danger" type="submit">Delete account and all data</button>
        </form>
      </Card>
    </>
  );
}
