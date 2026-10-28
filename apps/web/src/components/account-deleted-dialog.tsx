import { CheckCircle2 } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Shown on the landing page after an account is deleted. Loaded on demand, so the dialog code stays out of the landing bundle. */
export function AccountDeletedDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog defaultOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full border"><CheckCircle2 className="size-5 text-brand" /></div>
          <DialogTitle>Your account was deleted</DialogTitle>
          <DialogDescription>Your profile and all uploaded usage are gone from the server.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-3 text-sm text-muted-foreground">
          <li>If you sign in with GitHub again, you'll be asked before a new, empty account is created.</li>
          <li>To remove tokenburn from GitHub entirely, revoke it in GitHub → Settings → Applications → Authorized OAuth Apps.</li>
          <li>Machines you connected keep their local data. Run this on each to remove it:</li>
        </ul>
        <CopyCommand command="tokenburn forget" />
        <DialogFooter>
          <DialogClose asChild><Button>Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
