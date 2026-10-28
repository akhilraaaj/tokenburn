import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound({ message = "This page doesn't exist." }: { message?: string }) {
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-3 px-4 py-24 text-center">
      <span className="num text-sm text-subtle">404</span>
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted-foreground font-medium">{message}</p>
      <Button asChild variant="outline"><Link to="/">Go home</Link></Button>
    </div>
  );
}
