import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { LogoMark } from '@/components/brand';
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
    <div className="mx-auto grid w-full max-w-md gap-6 px-4 py-16 sm:py-24">
      <Card>
        <CardHeader className="justify-items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border bg-background"><LogoMark className="size-5" /></div>
          <div className="grid gap-1">
            <CardTitle className="text-xl">Create your tokenburn account</CardTitle>
            <CardDescription>
              {login ? <>Signed in with GitHub as <span className="font-medium text-foreground">{login}</span>.</> : <Skeleton className="h-4 w-48" />}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground">
          <p className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" />Only daily token counts are stored, never prompts or code. Your profile stays private until you publish it.</p>
          {error && <p className="text-destructive">{error}</p>}
        </CardContent>
        <CardFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" className="w-full sm:w-auto" onClick={cancel} disabled={busy}>Cancel</Button>
          <Button className="w-full sm:w-auto" onClick={create} disabled={busy || !login}>{busy ? 'Creating…' : 'Create account'}</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
