import { claudeCodeSource } from './claude-code.ts';
import { codexSource } from './codex.ts';
import { geminiCliSource } from './gemini-cli.ts';
import { grokCliSource } from './grok-cli.ts';
import { hermesSource } from './hermes.ts';
import { openCodeSource } from './opencode.ts';
import type { LocalSource } from './types.ts';

/** Every automatic local (device-scoped) source. Add new providers here. */
export const LOCAL_SOURCES: LocalSource[] = [claudeCodeSource, codexSource, openCodeSource, geminiCliSource, grokCliSource, hermesSource];

export type { LocalSource, ScanStats, SourceContext } from './types.ts';
