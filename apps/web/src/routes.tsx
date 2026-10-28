import { lazy, Suspense } from 'react';
import { Navigate, useLocation, type RouteObject } from 'react-router-dom';
import { PublicLayout } from '@/layouts/public-layout';
import { Landing } from '@/pages/landing';
import { NotFound } from '@/pages/not-found';
import { Profile } from '@/pages/profile';
import { RouteError } from '@/pages/route-error';
import { Welcome } from '@/pages/welcome';

// The signed-in app (sidebar, dialogs, settings) loads only when needed, keeping the landing page and
// public profiles light.
const AppLayout = lazy(() => import('@/layouts/app-layout').then((m) => ({ default: m.AppLayout })));
const Overview = lazy(() => import('@/pages/overview').then((m) => ({ default: m.Overview })));
const Models = lazy(() => import('@/pages/models').then((m) => ({ default: m.Models })));
const Machines = lazy(() => import('@/pages/machines').then((m) => ({ default: m.Machines })));
const Settings = lazy(() => import('@/pages/settings').then((m) => ({ default: m.Settings })));

/** /@username — React Router can't match a literal "@" prefix on a dynamic segment, so a catch-all checks it. */
function AtOrNotFound() {
  const seg = decodeURIComponent(useLocation().pathname.slice(1));
  return seg.startsWith('@') && !seg.slice(1).replace(/\/$/, '').includes('/') ? <Profile /> : <NotFound />;
}

/** Shared by the browser (main.tsx) and the build-time prerender of the landing page (entry-server.tsx). */
export const routes: RouteObject[] = [
  {
    element: <Suspense fallback={null}><AppLayout /></Suspense>,
    errorElement: <RouteError />,
    children: [
      { path: '/dashboard', element: <Overview /> },
      { path: '/dashboard/models', element: <Models /> },
      { path: '/dashboard/machines', element: <Machines /> },
      { path: '/dashboard/settings', element: <Settings /> },
    ],
  },
  { path: '/settings', element: <Navigate to="/dashboard/settings" replace /> },
  {
    element: <PublicLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/welcome', element: <Welcome /> },
      { path: '*', element: <AtOrNotFound /> },
    ],
  },
];
