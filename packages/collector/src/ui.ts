// Terminal styling for the CLI: colors, symbols, boxes and a spinner. No dependencies.
// Color and animation only on an interactive terminal; plain text when piped, logged (the background
// service), or when NO_COLOR is set. FORCE_COLOR=1 turns color on anyway.

const out = process.stdout;
const color = !!process.env.FORCE_COLOR || (!!out.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
const truecolor = color && /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const fancy = !!out.isTTY && process.env.TERM !== 'dumb';

const sgr = (open: string, close: string) => (s: string | number) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
// The site's palette (series-1 blue, series-2 orange) when the terminal can show it; nearest ANSI colors otherwise.
const rgb = (r: number, g: number, b: number, fallback: string) => sgr(truecolor ? `38;2;${r};${g};${b}` : fallback, '39');

export const c = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  italic: sgr('3', '23'),
  underline: sgr('4', '24'),
  blue: rgb(57, 135, 229, '34'),
  orange: rgb(235, 104, 52, '33'),
  green: rgb(27, 175, 122, '32'),
  red: rgb(229, 72, 77, '31'),
  yellow: rgb(237, 161, 0, '33'),
  cyan: sgr('36', '39'),
  gray: sgr('90', '39'),
};

export const sym = {
  ok: c.green('✔'),
  fail: c.red('✖'),
  warn: c.yellow('▲'),
  info: c.blue('●'),
  off: c.gray('○'),
  arrow: c.gray('›'),
  dot: c.gray('·'),
};

// eslint-disable-next-line no-control-regex
export const visibleLength = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
export const padEnd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visibleLength(s)));

/** A command the user can copy, highlighted the same way everywhere. */
export const cmd = (s: string) => c.cyan(s);
export const link = (s: string) => c.underline(c.blue(s));

/** The logo: three ascending bars (blue, blue, orange) like the favicon. */
export const logo = () => `${c.blue('▃▅')}${c.orange('█')} ${c.bold('tokenburn')}`;

export const log = (s = '') => console.log(s);
export const ok = (s: string) => log(`${sym.ok} ${s}`);
export const warn = (s: string) => log(`${sym.warn} ${s}`);
export const info = (s: string) => log(`${sym.info} ${s}`);
export const fail = (s: string) => console.error(`${sym.fail} ${s}`);
/** Indented secondary line under a status line. */
export const note = (s: string) => log(`  ${c.dim(s)}`);
/** "Next" hint: › description  command */
export const hint = (text: string, command?: string) => log(`  ${sym.arrow} ${text}${command ? `  ${cmd(command)}` : ''}`);

/** Section heading for multi-step flows: " 2/5  Find your AI tools". */
export function step(n: number, total: number, title: string) {
  log();
  log(`${c.bold(c.blue(`${n}/${total}`))}  ${c.bold(title)}`);
}

export function heading(title: string) {
  log();
  log(c.bold(title));
}

/** Aligned "label  value" rows. */
export function rows(items: [string, string][], indent = 2) {
  const w = Math.max(...items.map(([k]) => visibleLength(k)));
  for (const [k, v] of items) log(`${' '.repeat(indent)}${c.dim(padEnd(k, w))}  ${v}`);
}

/** Rounded box around a few lines (sign-in codes, summaries). */
export function box(lines: string[], opts: { title?: string; tone?: (s: string) => string } = {}) {
  const tone = opts.tone ?? c.gray;
  const inner = Math.max(...lines.map(visibleLength), opts.title ? visibleLength(opts.title) + 2 : 0);
  const top = opts.title ? `╭─ ${opts.title} ${'─'.repeat(Math.max(0, inner - visibleLength(opts.title) - 1))}╮` : `╭${'─'.repeat(inner + 2)}╮`;
  log(tone(top));
  for (const l of lines) log(`${tone('│')} ${padEnd(l, inner)} ${tone('│')}`);
  log(tone(`╰${'─'.repeat(inner + 2)}╯`));
}

/** Spinner for slow steps. Prints a plain line instead when not on a terminal. */
export function spinner(text: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let current = text;
  let timer: NodeJS.Timeout | null = null;
  const clear = () => fancy && out.write('\r\x1b[2K');
  if (fancy) {
    out.write('\x1b[?25l'); // hide cursor
    timer = setInterval(() => out.write(`\r\x1b[2K${c.blue(frames[i++ % frames.length])} ${current}`), 80);
    process.once('exit', () => out.write('\x1b[?25h'));
  }
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    clear();
    if (fancy) out.write('\x1b[?25h');
  };
  return {
    update(t: string) { current = t; },
    succeed(t: string) { stop(); ok(t); },
    fail(t: string) { stop(); fail(t); },
    warn(t: string) { stop(); warn(t); },
    stop,
  };
}

/** Runs `fn` with a spinner; the spinner clears itself if `fn` throws. */
export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const s = spinner(text);
  try {
    return await fn();
  } finally {
    s.stop();
  }
}
