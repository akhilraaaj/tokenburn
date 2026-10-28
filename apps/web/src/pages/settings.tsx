import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { useDashboard } from '@/layouts/app-layout';
import { useSession } from '@/session';
import { PageHeading } from './overview';

type Availability = { state: 'idle' | 'checking' | 'ok' | 'bad'; reason?: string };

const FLAGS: [keyof ProfileSettings, string, string][] = [
  ['show_github', 'GitHub account', 'Your GitHub avatar and a link to your GitHub profile'],
  ['show_providers', 'Tools', 'Which tools you use and their data source'],
  ['show_models', 'Models', 'Which models you use, with request counts'],
  ['show_token_totals', 'Token totals', 'Input, output, cache and total tokens'],
  ['show_daily_trend', 'Daily trend', 'Day-by-day chart (90 days) and contribution graph (past year)'],
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
  const [savingUsername, setSavingUsername] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ state: 'idle' });

  const load = async () => {
    const d = await api<SettingsData>('GET', '/api/web/settings');
    setData(d);
    setUsername(d.user.username ?? '');
    setProfile(d.profile);
  };
  useEffect(() => { void load(); }, []);

  const savedUsername = data?.user.username ?? null;
  const draft = username.trim().toLowerCase();
  const unchanged = draft === (savedUsername ?? '');

  // Debounced availability check; your own saved name counts as available.
  useEffect(() => {
    if (!draft || unchanged) {
      setAvailability({ state: 'idle' });
      return;
    }
    setAvailability({ state: 'checking' });
    let live = true;
    const t = setTimeout(() => {
      api<{ available: boolean; reason?: string }>('GET', `/api/web/username-available?name=${encodeURIComponent(draft)}`)
        .then((r) => live && setAvailability(r.available ? { state: 'ok' } : { state: 'bad', reason: r.reason }))
        .catch(() => live && setAvailability({ state: 'idle' }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft, unchanged]);

  if (!data || !profile) return <div className="grid gap-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>;

  const flag = (k: keyof ProfileSettings) => !!profile[k];
  const set = (k: keyof ProfileSettings, v: boolean) => setProfile({ ...profile, [k]: v });
  const host = new URL(data.origin).host;
  const canSaveUsername = !!draft && !unchanged && availability.state === 'ok' && !savingUsername;

  const saveUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSaveUsername) return;
    setSavingUsername(true);
    try {
      const r = await api<{ username: string }>('PUT', '/api/web/username', { username: draft });
      await Promise.all([refresh(), load()]);
      toast.success(`Username set to @${r.username}`);
    } catch (err) { toast.error(errorText(err)); } finally { setSavingUsername(false); }
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
          <CardDescription className="font-medium">Your public profile URL. Letters, digits, _ or -, 3–30 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveUsername} className="grid max-w-lg grid-cols-1 gap-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex h-9 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40">
                <span className="flex h-full shrink-0 items-center border-r bg-surface-2 px-3 font-mono text-sm text-muted-foreground font-medium">
                  <span className="hidden sm:inline">{host}/</span>@
                </span>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30))}
                  maxLength={30}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="yourname"
                  aria-label="Username"
                  className="h-full min-w-0 rounded-none border-0 bg-transparent px-2.5 font-mono font-medium shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
                />
                <span className="flex items-center pr-2.5 text-subtle font-medium">
                  {availability.state === 'checking' && <Loader2 className="size-3.5 animate-spin" />}
                  {availability.state === 'ok' && <Check className="size-3.5" style={{ color: 'var(--series-3)' }} />}
                </span>
              </div>
              <Button type="submit" disabled={!canSaveUsername} className="sm:w-auto">
                {savingUsername ? 'Saving…' : savedUsername ? 'Change' : 'Claim'}
              </Button>
            </div>
            <p className={cn(
              'min-h-4 text-xs',
              availability.state === 'bad' ? 'text-destructive'
                : availability.state === 'ok' ? 'text-foreground'
                  : 'text-muted-foreground',
            )}>
              {availability.state === 'bad' && (availability.reason ?? 'Not available')}
              {availability.state === 'ok' && 'Available'}
              {availability.state === 'checking' && 'Checking…'}
              {availability.state === 'idle' && unchanged && savedUsername && (
                <Link to={`/@${savedUsername}`} className="inline-flex items-center gap-1 mt-1 hover:text-foreground font-medium">
                  {host}/@{savedUsername}<ExternalLink className="size-3" />
                </Link>
              )}
              {availability.state === 'idle' && !savedUsername && 'Pick a handle to claim your profile.'}
            </p>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public profile</CardTitle>
          <CardDescription className="font-medium">Private by default. When public, only what you switch on is shown. Device names, file paths, session contents and emails never are.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="grid gap-1.5">
              <Label htmlFor="is_public" className="font-medium">Make my profile public</Label>
              <span className="text-xs text-muted-foreground font-medium">{data.user.username ? `${host}/@${data.user.username}` : 'Set a username first'}</span>
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
                  <div className="grid gap-1.5">
                    <Label htmlFor={k}>{label}</Label>
                    <span className="text-xs text-muted-foreground font-medium">{help}</span>
                  </div>
                  <Switch id={k} checked={flag(k)} onCheckedChange={(v) => set(k, v)} />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-3 border-t">
          {data.user.username ? (
            <Button asChild variant="link" className="px-0 font-medium"><Link to={`/@${data.user.username}`}>View profile <ExternalLink /></Link></Button>
          ) : <span />}
          <Button onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Machines</CardTitle>
          <CardDescription className="font-medium">Disconnecting a machine also deletes the usage it uploaded.</CardDescription>
        </CardHeader>
        <CardContent className="grid">
          {data.devices.length ? data.devices.map((d, i) => (
            <div key={d.id}>
              {i > 0 && <Separator />}
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">{d.name}</span>
                  <span className="text-xs text-muted-foreground font-medium">Connected {d.created_at.slice(0, 10)} · last sync {timeAgo(d.last_sync_at)}</span>
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
          <CardDescription className="font-medium">Connected machines upload their history again on the next sync unless you disconnect them.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Delete uploaded usage</span>
              <span className="text-xs text-muted-foreground font-medium">Removes it from the server for one tool or all of them.</span>
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
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Delete account</span>
              <span className="text-xs text-muted-foreground font-medium">Deletes your account, profile and all uploaded usage.</span>
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    // Controlled: the action keeps the dialog open while it runs (preventDefault), so it closes it on success itself.
    // A failure leaves it open with the error toast, to retry or cancel. No closing mid-request.
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disabled || busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } catch (err) {
                toast.error(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
