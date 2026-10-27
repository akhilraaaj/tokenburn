import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A shell command in a quiet monospace block with a copy button. */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border bg-surface-2/60 py-1.5 pr-1.5 pl-3.5 font-mono text-[0.82rem]', className)}>
      <span className="select-none text-subtle">$</span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre no-scrollbar">{command}</code>
      <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={copied ? 'Copied' : 'Copy command'}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
