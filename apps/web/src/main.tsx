import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { Layout, SessionProvider } from './components/Layout.tsx';
import { Card } from './components/ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Landing } from './pages/Landing.tsx';
import { Profile } from './pages/Profile.tsx';
import { Settings } from './pages/Settings.tsx';

const NotFound = () => <Card><h1 className="text-[1.6rem] font-semibold">Not found</h1><p className="text-secondary">This page doesn't exist.</p></Card>;

// /@username: React Router can't match a literal "@" prefix on a dynamic segment, so a splat route checks it.
function AtRoute() {
  const seg = decodeURIComponent(location.pathname.slice(1));
  return seg.startsWith('@') ? <Profile /> : <NotFound />;
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/settings', element: <Settings /> },
      { path: '/:username', element: <AtRoute /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
