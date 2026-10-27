import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/** Shown instead of React Router's developer error page when something throws while rendering. */
export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);
  return (
    <div className="mx-auto grid min-h-svh max-w-lg content-center justify-items-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">The page hit an unexpected error. Reloading usually fixes it.</p>
      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <Button asChild variant="outline"><Link to="/" reloadDocument>Go home</Link></Button>
      </div>
      <code className="mt-2 max-w-full overflow-x-auto rounded bg-surface-2 px-2 py-1 text-xs text-subtle">{detail}</code>
    </div>
  );
}
