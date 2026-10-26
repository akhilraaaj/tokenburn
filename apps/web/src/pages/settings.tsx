import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { PROVIDER_LABELS, type ProfileSettings, type WebDevice, type WebUser } from '../../../../packages/shared/src/index.ts';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api.ts';
import { timeAgo } from '@/lib/format.ts';
import { useDashboard } from '@/layouts/app-layout';
import { useSession } from '@/session';
import { PageHeading } from './overview';

const FLAGS: [keyof ProfileSettings, string, string][] = [
  ['show_github', 'GitHub account', 'Your GitHub avatar and a link to your GitHub profile'],
  ['show_providers', 'Tools', 'Which tools you use and their data source'],
  ['show_models', 'Models', 'Which models you use, with request counts'],
  ['show_token_totals', 'Token totals', 'Input, output, cache and total tokens'],
  ['show_daily_trend', 'Daily trend', 'Day-by-day chart (90 days) and contribution graph (past year)'],
  ['show_sessions', 'Session count', 'Number of sessions'],
  ['show_streaks', 'Streaks & best day', 'Current and longest streak, best day'],
  ['show_costs', 'Estimated cost', 'API list-price estimate, not your bill'],
];

interface SettingsData { user: WebUser; profile: ProfileSettings; devices: WebDevice[]; origin: string }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function Settings() {
  const { refresh } = useSession();
  const { reload } = useDashboard();
  const navigate = useNavigate();
  const [data, setData] = useState<SettingsData | null>(null);
  const [username, setUsername] = useState('');
  const [profile, setProfile] = useState<ProfileSettings | null>(null);
  const [provider, setProvider] = useState('all');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const d = await api<SettingsData>('GET', '/api/web/settings');
    setData(d);
    setUsername(d.user.username ?? '');
    setProfile(d.profile);
  };
  useEffect(() => { void load(); }, []);

  if (!data || !profile) return <div className="grid gap-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>;

  const flag = (k: keyof ProfileSettings) => !!profile[k];
  const set = (k: keyof ProfileSettings, v: boolean) => setProfile({ ...profile, [k]: v });
  const host = new URL(data.origin).host;

  const saveUsername = async () => {
    try {
      const r = await api<{ username: string }>('PUT', '/api/web/username', { username });
      await Promise.all([refresh(), load()]);
      toast.success(`Username set to @${r.username}`);
    } catch (e) { toast.error(errorText(e)); }
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      const body = Object.fromEntries(FLAGS.map(([k]) => [k, flag(k)]));
      const p = await api<ProfileSettings>('PATCH', '/api/web/profile', { ...body, is_public: flag('is_public'), display_name: profile.display_name ?? '' });
      setProfile(p);
      toast.success(p.is_public ? 'Saved · your profile is public' : 'Saved · your profile is private');
    } catch (e) { toast.error(errorText(e)); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeading title="Settings" description="Your username, public profile and data" />

      <Card>
        <CardHeader>
          <CardTitle>Username</CardTitle>
          <CardDescription>Your public profile lives at {host}/@{data.user.username ?? 'username'}.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-md items-center gap-2">
            <div className="flex flex-1 items-center rounded-md border bg-background pl-3 text-sm focus-within:ring-2 focus-within:ring-ring/50">
              <span className="text-subtle">{host}/@</span>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} className="border-0 pl-0.5 shadow-none focus-visible:ring-0" aria-label="Username" />
            </div>
            <Button variant="outline" onClick={saveUsername} disabled={!username || username === data.user.username}>Save</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public profile</CardTitle>
          <CardDescription>Private by default. When public, only what you switch on is shown. Device names, file paths, session contents and emails never are.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-0.5">
              <Label htmlFor="is_public" className="font-medium">Make my profile public</Label>
              <span className="text-xs text-muted-foreground">{data.user.username ? `${host}/@${data.user.username}` : 'Set a username first'}</span>
            </div>
            <Switch id="is_public" checked={flag('is_public')} disabled={!data.user.username} onCheckedChange={(v) => set('is_public', v)} />
          </div>
          <div className="grid max-w-md gap-2">
            <Label htmlFor="display_name">Display name</Label>
            <Input id="display_name" maxLength={60} value={profile.display_name ?? ''} onChange={(e) => setProfile({ ...profile, display_name: e.target.value })} placeholder="Optional" />
          </div>
          <div className="grid">
            {FLAGS.map(([k, label, help], i) => (
              <div key={k}>
                {i > 0 && <Separator />}
                <div className="flex items-center justify-between gap-4 py-3">
                  <div className="grid gap-0.5">
                    <Label htmlFor={k}>{label}</Label>
                    <span className="text-xs text-muted-foreground">{help}</span>
                  </div>
                  <Switch id={k} checked={flag(k)} onCheckedChange={(v) => set(k, v)} />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-3 border-t">
          {data.user.username ? (
            <Button asChild variant="link" className="px-0"><Link to={`/@${data.user.username}`}>View profile <ExternalLink /></Link></Button>
          ) : <span />}
          <Button onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Machines</CardTitle>
          <CardDescription>Disconnecting a machine also deletes the usage it uploaded.</CardDescription>
        </CardHeader>
        <CardContent className="grid">
          {data.devices.length ? data.devices.map((d, i) => (
            <div key={d.id}>
              {i > 0 && <Separator />}
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium">{d.name}</span>
                  <span className="text-xs text-muted-foreground">Connected {d.created_at.slice(0, 10)} · last sync {timeAgo(d.last_sync_at)}</span>
                </div>
                <Confirm
                  trigger={<Button variant="destructive" size="sm">Disconnect</Button>}
                  title={`Disconnect ${d.name}?`}
                  description="Its token stops working and the usage it uploaded is deleted. Running setup on it again reconnects it."
                  action="Disconnect"
                  onConfirm={async () => {
                    await api('DELETE', `/api/web/devices/${d.id}`);
                    await load();
                    reload();
                    toast.success('Machine disconnected');
                  }}
                />
              </div>
            </div>
          )) : <p className="text-sm text-subtle">No machines yet.</p>}
        </CardContent>
      </Card>

      <Card className="ring-destructive/30">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>Connected machines upload their history again on the next sync unless you disconnect them.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <span className="text-sm font-medium">Delete uploaded usage</span>
              <span className="text-xs text-muted-foreground">Removes it from the server for one tool or all of them.</span>
            </div>
            <div className="flex items-center gap-2">
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tools</SelectItem>
                  {Object.entries(PROVIDER_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Confirm
                trigger={<Button variant="destructive" size="sm">Delete</Button>}
                title="Delete uploaded usage?"
                description={`This permanently deletes ${provider === 'all' ? 'all uploaded usage' : `uploaded ${PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS]} usage`} from the server.`}
                action="Delete"
                onConfirm={async () => {
                  await api('DELETE', `/api/web/data?provider=${provider}`);
                  reload();
                  toast.success('Uploaded usage deleted');
                }}
              />
            </div>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <span className="text-sm font-medium">Delete account</span>
              <span className="text-xs text-muted-foreground">Deletes your account, profile and all uploaded usage.</span>
            </div>
            <Confirm
              trigger={<Button variant="destructive" size="sm">Delete account</Button>}
              title="Delete your account?"
              description='This cannot be undone. Type "delete my account" to confirm.'
              action="Delete account"
              body={<Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="delete my account" />}
              disabled={confirm !== 'delete my account'}
              onConfirm={async () => {
                await api('DELETE', '/api/web/account', { confirm });
                // Leave the dashboard before clearing the session; otherwise its own signed-out redirect to "/" wins.
                navigate('/?deleted=1', { replace: true });
                await refresh();
              }}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function Confirm({ trigger, title, description, action, onConfirm, body, disabled }: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onConfirm: () => Promise<void>;
  body?: React.ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disabled || busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try { await onConfirm(); } catch (err) { toast.error(errorText(err)); } finally { setBusy(false); }
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
