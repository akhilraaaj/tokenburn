// Display names only. Stored model ids are never rewritten.
const KNOWN: Record<string, string> = {
  default: 'Auto (model not reported)',
  auto: 'Auto (model not reported)',
};

export function modelDisplayName(modelId: string): string {
  if (KNOWN[modelId]) return KNOWN[modelId];
  // claude-opus-4-5-20251101 → Claude Opus 4.5 ; claude-4.5-sonnet-thinking → Claude 4.5 Sonnet Thinking
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(modelId);
  if (m) return `Claude ${cap(m[1])} ${m[2]}.${m[3]}`;
  const m2 = /^claude-([a-z]+)-(\d+)(?:-\d{8})?$/.exec(modelId);
  if (m2) return `Claude ${cap(m2[1])} ${m2[2]}`;
  return modelId;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Model id as uploaded. Ids are kept verbatim except: local file paths (custom/local models) are reduced to
 * the file name so a path never reaches the server or a public page, and ids are capped at 200 characters.
 */
export function uploadModelId(modelId: string): string {
  let id = modelId.trim();
  const looksLikePath = /^(?:[/~]|[A-Za-z]:[\\/]|\\\\|file:)/.test(id) || id.includes('\\');
  if (looksLikePath) id = id.split(/[\\/]/).filter(Boolean).pop() ?? 'local-model';
  return (id || 'unknown').slice(0, 200);
}
