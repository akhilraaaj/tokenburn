// Imported first by the CLI: hides Node's one-time "SQLite is experimental" warning, which would
// otherwise print on every command. Other warnings still show. node:sqlite is loaded at runtime via
// process.getBuiltinModule (store.ts, sources/sqlite.ts) so this filter is installed before it loads.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(msg ?? '')) return;
  return (emit as any)(warning, ...rest);
}) as typeof process.emitWarning;
