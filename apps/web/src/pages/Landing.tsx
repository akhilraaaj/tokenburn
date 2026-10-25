import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '../components/Layout.tsx';
import { Card, Notice } from '../components/ui.tsx';

export function Landing() {
  const { user } = useSession();
  const [params] = useSearchParams();
  // Fixed messages only: the URL carries a code, never text shown verbatim.
  const ERRORS: Record<string, string> = {
    not_configured: 'GitHub sign-in is not configured on this server yet.',
    failed: 'Sign-in with GitHub failed or was cancelled. Please try again.',
    expired: 'That sign-in link expired. Please try again.',
    rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  };
  const error = ERRORS[params.get('error') ?? ''];
  return (
    <>
      {error && <Notice>{error}</Notice>}
      <Card>
        <h1 className="text-[1.6rem] font-semibold leading-tight">Your AI coding usage, in one place</h1>
        <p className="text-secondary">
          See which models you use across Claude Code, Codex CLI, OpenCode, Gemini CLI, Cursor, Grok CLI, Hermes and OpenRouter:
          tokens, trends, streaks and estimated cost. Share a public profile like <code>{location.host}/@you</code> if you want to.
        </p>
        <div className="flex gap-3">
          {user ? <Link to="/dashboard" className="btn btn-primary">Open your dashboard</Link> : <a href="/login" className="btn btn-primary">Sign in with GitHub</a>}
        </div>
      </Card>
      <section className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
        <Card>
          <h2 className="font-semibold">Collected on your machine</h2>
          <p className="text-secondary">A small terminal app reads your tools' local usage records and uploads only daily totals per model.
            Prompts, code, file paths and API keys never leave your computer.</p>
          <pre>npx use-tokenburn setup</pre>
        </Card>
        <Card>
          <h2 className="font-semibold">Private until you share</h2>
          <p className="text-secondary">Your dashboard is private. The public profile is off by default, and you pick exactly what it
            shows: tools, models, tokens, trend, streaks, cost.</p>
        </Card>
      </section>
    </>
  );
}
