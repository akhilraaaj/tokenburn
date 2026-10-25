import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { WebUser } from '../../../packages/shared/src/index.ts';
import { api } from '@/lib/api.ts';

interface Session {
  user: WebUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session>({ user: null, loading: true, refresh: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const r = await api<{ user: WebUser | null }>('GET', '/api/web/session').catch(() => ({ user: null }));
    setUser(r.user);
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);
  return <SessionContext.Provider value={{ user, loading, refresh }}>{children}</SessionContext.Provider>;
}

export async function signOut(refresh: () => Promise<void>) {
  await api('POST', '/api/web/logout');
  await refresh();
}
