import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicProfile } from '../../../../packages/shared/src/index.ts';
import { Chart } from '../components/Chart.tsx';
import { useSession } from '../components/Layout.tsx';
import { ModelTable } from '../components/ModelTable.tsx';
import { Card, HighlightTiles, Loading, Tile, Tiles } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { fmt } from '../lib/format.ts';
import { colorMap, METRIC_LABEL, providerLabel } from '../lib/series.ts';

export function Profile() {
  const { username = '' } = useParams();
  const handle = username.replace(/^@/, '').toLowerCase();
  const { user } = useSession();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProfile(null);
    setMissing(false);
    api<PublicProfile>('GET', `/api/public/${encodeURIComponent(handle)}?days=90`)
      .then((p) => { setProfile(p); document.title = `@${p.username} · AI coding usage`; })
      .catch((e: ApiError) => { if (e.status === 404) setMissing(true); });
  }, [handle]);

  const breakdown = profile?.breakdown ?? [];
  const colorOf = useMemo(() => colorMap(profile?.daily?.length ? profile.daily : breakdown), [profile]);

  if (missing) {
    const own = user?.username === handle;
    return (
      <Card>
        <h1 className="text-[1.6rem] font-semibold">{own ? 'Your profile is private' : 'Not found'}</h1>
        <p className="text-secondary">{own ? 'Turn it on in Settings → Public profile.' : "This profile doesn't exist or is private."}</p>
        {own && <p><Link to="/settings" className="btn">Open settings</Link></p>}
      </Card>
    );
  }
  if (!profile) return <Loading />;

  const providers = [...new Set(breakdown.map((b) => b.provider).filter(Boolean))] as string[];
  const h = profile.highlights ?? {};
  const metric = profile.shows.tokens ? 'output' : 'requests';
  const empty = !profile.daily && !breakdown.length && !profile.sessions && !Object.keys(h).length;

  return (
    <>
      <Card>
        <p className="text-muted">@{profile.username}</p>
        <h1 className="text-[1.6rem] font-semibold leading-tight">{profile.display_name || profile.username}</h1>
        <p className="text-secondary text-[0.85rem]">AI coding usage · last 90 days (UTC){providers.length ? ` · ${providers.map(providerLabel).join(' + ')}` : ''}</p>
      </Card>
      <HighlightTiles h={h} {...profile.shows} windowLabel="last 90 days" />
      {profile.sessions && Object.keys(profile.sessions).length > 0 && (
        <Tiles>{Object.entries(profile.sessions).map(([k, v]) => <Tile key={k} label={k === 'all' ? 'Sessions' : `${providerLabel(k)} sessions`} value={fmt(v)} />)}</Tiles>
      )}
      {profile.daily && (
        <Card><h2 className="font-semibold">{METRIC_LABEL[metric]} per day</h2><Chart rows={profile.daily} since={profile.since} metric={metric} colorOf={colorOf} /></Card>
      )}
      {breakdown.length > 0 && (
        <Card><h2 className="font-semibold">{breakdown[0].model_id ? 'Models' : 'Tools'}</h2>
          <ModelTable rows={breakdown} colorOf={colorOf} tokens={profile.shows.tokens} costs={profile.shows.costs} /></Card>
      )}
      {empty && <Card><p className="text-muted">This profile is public but shares no usage details yet.</p></Card>}
      <footer className="text-[0.8rem] text-muted">
        Token counts come from each tool's own records and aren't comparable across tools in every detail.
        {profile.shows.costs && ' Costs are API list-price estimates unless billed by the provider; they are not what a subscription costs.'}
        {!user && <> <a href="/">Make your own</a></>}
      </footer>
    </>
  );
}
