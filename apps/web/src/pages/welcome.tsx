import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { GitHubMark, LogoMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
import { useSession } from '@/session';

/**
 * Where GitHub sign-in lands for a GitHub user without an account. Creating the account is an explicit step
 * (GitHub skips its own consent screen for apps you've approved before); the rest of onboarding happens on the
 * dashboard's welcome screen.
 */
export function Welcome() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ github_login: string }>('GET', '/api/web/pending').then((r) => setLogin(r.github_login)).catch(() => setLogin(null));
  }, []);

  if (login === null) return <Navigate to="/" replace />;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/web/signup');
      await refresh();
      navigate('/dashboard', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try signing in again.');
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    await api('POST', '/api/web/signup/cancel').catch(() => {});
    navigate('/', { replace: true });
  };

  return (
    <div className="mx-auto grid w-full max-w-lg gap-6 px-4 py-16 sm:py-24">
      <Card className="gap-6 py-8">
        <CardHeader className="justify-items-center gap-5 text-center">
          {/* GitHub connecting to tokenburn: the identity this page is about to turn into an account. */}
          <div className="flex items-center gap-3" aria-hidden>
            <span className="flex size-12 items-center justify-center rounded-2xl border bg-background shadow-xs"><GitHubMark className="size-5" /></span>
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => <span key={i} className="size-1 rounded-full bg-border" />)}
            </span>
            <span className="flex size-12 items-center justify-center rounded-2xl border bg-background shadow-xs"><LogoMark className="size-6" /></span>
          </div>
          <div className="grid gap-2">
            <CardTitle className="text-xl tracking-tight">Create your tokenburn account</CardTitle>
            <CardDescription className="grid justify-items-center font-medium">
              {login ? <span>Signed in with GitHub as <span className="font-semibold text-foreground">{login}</span></span> : <Skeleton className="h-4 w-48" />}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <ul className="grid gap-2.5 rounded-xl border bg-muted/30 p-4 text-muted-foreground font-medium">
            {[
              'Only daily token counts are stored, never prompts or code',
              'Your profile stays private until you publish it',
              'Delete everything anytime from Settings',
            ].map((t) => (
              <li key={t} className="flex gap-2.5"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--series-3)]" />{t}</li>
            ))}
          </ul>
          {error && <p className="text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="grid gap-2">
          <Button size="lg" className="w-full" onClick={create} disabled={busy || !login}>{busy ? 'Creating…' : 'Create account'}</Button>
          <Button variant="ghost" className="w-full text-muted-foreground" onClick={cancel} disabled={busy}>Cancel</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
