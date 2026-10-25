// Automatic sync: the OS runs `tokenburn sync --auto` every 30 minutes. Nothing stays resident between runs.
// macOS: launchd agent (StartInterval). Linux: systemd user timer, or a crontab line without systemd.
// Windows: Task Scheduler task running a hidden VBScript wrapper.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from './paths.ts';

const LABEL = 'com.tokenburn.sync';
export const INTERVAL_MIN = 30;
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const systemdDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
export const logPath = () => path.join(stateDir(), 'sync.log');

/** The command the scheduler runs: this same Node binary and CLI script. */
function command(): string[] {
  return [process.execPath, fs.realpathSync(process.argv[1]), 'sync', '--auto'];
}

/** npx caches can be cleared at any time, which would break a schedule pointing into them. */
export function runningFromNpxCache(): boolean {
  return /[\\/]_npx[\\/]/.test(process.argv[1] ?? '');
}

function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = { HOME: os.homedir() };
  for (const k of ['TOKENBURN_HOME', 'TOKENBURN_API_URL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'GEMINI_CLI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PATH']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist(cmd = command(), env = passthroughEnv(), log = logPath()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${cmd.map((c) => `<string>${xml(c)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>StartInterval</key><integer>${INTERVAL_MIN * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function renderSystemdUnits(cmd = command(), env = passthroughEnv(), log = logPath()) {
  const service = `[Unit]
Description=tokenburn sync

[Service]
Type=oneshot
ExecStart=${cmd.map((c) => JSON.stringify(c)).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${JSON.stringify(`${k}=${v}`)}`).join('\n')}
Nice=10
IOSchedulingClass=idle
StandardOutput=append:${log}
StandardError=append:${log}
`;
  const timer = `[Unit]
Description=Run tokenburn sync every ${INTERVAL_MIN} minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MIN}min
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

// ----- Windows: Task Scheduler runs a tiny VBScript that starts the sync with no console window -----

const WIN_TASK = 'tokenburn sync';
const winScript = () => path.join(stateDir(), 'tokenburn-sync.vbs');
const vbsString = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function renderWindowsScript(cmd = command(), env = passthroughEnv(), log = logPath()): string {
  // cmd /c ""node" "cli" sync --auto >> "log" 2>&1": the outer quotes are required by cmd's /c parsing.
  const line = `cmd /c ""${cmd[0]}" ${cmd.slice(1).map((c) => (c.startsWith('-') || c === 'sync' ? c : `"${c}"`)).join(' ')} >> "${log}" 2>&1"`;
  return [
    "' tokenburn automatic sync. Started by Windows Task Scheduler every 30 minutes; window style 0 = hidden.",
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("Process")',
    ...Object.entries(env).filter(([k]) => k !== 'PATH' && k !== 'HOME').map(([k, v]) => `env(${vbsString(k)}) = ${vbsString(v)}`),
    `sh.Run ${vbsString(line)}, 0, True`,
    '',
  ].join('\r\n');
}

export function windowsTaskArgs(script = winScript()): string[] {
  return ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(INTERVAL_MIN), '/TN', WIN_TASK, '/TR', `wscript.exe "${script}"`];
}

// ----- Linux without systemd (WSL, containers, minimal distros): a crontab line -----

const CRON_MARK = '# tokenburn-auto-sync';
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function renderCronLine(cmd = command(), env = passthroughEnv(), log = logPath()): string {
  const vars = Object.entries(env).filter(([k]) => k !== 'PATH').map(([k, v]) => `${k}=${shQuote(v)}`).join(' ');
  return `*/${INTERVAL_MIN} * * * * ${vars} ${cmd.map(shQuote).join(' ')} >> ${shQuote(log)} 2>&1 ${CRON_MARK}`;
}

function hasSystemdUser(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no crontab yet
  }
}

function writeCrontab(lines: string[]) {
  execFileSync('crontab', ['-'], { input: lines.filter((l) => l.trim()).join('\n') + '\n' });
}

export function installService(): string {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), renderPlist());
    const domain = `gui/${process.getuid!()}`;
    try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', domain, plistPath()]);
    return `Automatic sync on: every ${INTERVAL_MIN} minutes and at login (launchd agent ${plistPath()}). Log: ${logPath()}`;
  }
  if (process.platform === 'linux') {
    if (hasSystemdUser()) {
      const { service, timer } = renderSystemdUnits();
      fs.mkdirSync(systemdDir(), { recursive: true });
      fs.writeFileSync(path.join(systemdDir(), 'tokenburn.service'), service);
      fs.writeFileSync(path.join(systemdDir(), 'tokenburn.timer'), timer);
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', 'tokenburn.timer']);
      return `Automatic sync on: every ${INTERVAL_MIN} minutes (systemd user timer). Log: ${logPath()}\n` +
        'On a server you log out of, also run `loginctl enable-linger $USER` so the timer keeps running.';
    }
    try {
      execFileSync('crontab', ['-l'], { stdio: 'ignore' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No systemd user session and no `crontab` found. Install cron, or run `tokenburn sync` yourself.');
    }
    writeCrontab([...readCrontab().split('\n').filter((l) => !l.includes(CRON_MARK)), renderCronLine()]);
    return `Automatic sync on: every ${INTERVAL_MIN} minutes (crontab entry; no systemd user session found). Log: ${logPath()}\n` +
      'Make sure the cron service is running (e.g. on WSL: `sudo service cron start`).';
  }
  if (process.platform === 'win32') {
    fs.writeFileSync(winScript(), renderWindowsScript());
    execFileSync('schtasks', windowsTaskArgs(), { stdio: 'ignore' });
    try { execFileSync('schtasks', ['/Run', '/TN', WIN_TASK], { stdio: 'ignore' }); } catch {}
    return `Automatic sync on: every ${INTERVAL_MIN} minutes while you're signed in (Task Scheduler task "${WIN_TASK}"). Log: ${logPath()}`;
  }
  throw new Error(`Automatic sync isn't supported on ${process.platform}. Run \`tokenburn sync\` yourself, or \`tokenburn watch\` in a terminal.`);
}

export function uninstallService(): string {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    const existed = fs.existsSync(plistPath());
    fs.rmSync(plistPath(), { force: true });
    return existed ? 'Automatic sync off (launchd agent removed).' : 'Automatic sync was not installed.';
  }
  if (process.platform === 'linux') {
    let removed = false;
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'tokenburn.timer'], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(path.join(systemdDir(), 'tokenburn.timer'))) removed = true;
    fs.rmSync(path.join(systemdDir(), 'tokenburn.timer'), { force: true });
    fs.rmSync(path.join(systemdDir(), 'tokenburn.service'), { force: true });
    const cron = readCrontab();
    if (cron.includes(CRON_MARK)) {
      try { writeCrontab(cron.split('\n').filter((l) => !l.includes(CRON_MARK))); removed = true; } catch {}
    }
    return removed ? 'Automatic sync off.' : 'Automatic sync was not installed.';
  }
  if (process.platform === 'win32') {
    let removed = false;
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', WIN_TASK], { stdio: 'ignore' }); removed = true; } catch {}
    fs.rmSync(winScript(), { force: true });
    return removed ? 'Automatic sync off (scheduled task removed).' : 'Automatic sync was not installed.';
  }
  return 'Automatic sync was not installed.';
}

export function serviceStatus(): string {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(plistPath())) return 'off';
    try {
      execFileSync('launchctl', ['print', `gui/${process.getuid!()}/${LABEL}`], { stdio: 'ignore' });
      return `on (every ${INTERVAL_MIN} min)`;
    } catch {
      return 'installed but not loaded (run `tokenburn service install`)';
    }
  }
  if (process.platform === 'linux') {
    if (fs.existsSync(path.join(systemdDir(), 'tokenburn.timer'))) {
      try {
        execFileSync('systemctl', ['--user', 'is-active', '--quiet', 'tokenburn.timer']);
        return `on (every ${INTERVAL_MIN} min, systemd timer)`;
      } catch {
        return 'installed but inactive (run `tokenburn service install`)';
      }
    }
    return readCrontab().includes(CRON_MARK) ? `on (every ${INTERVAL_MIN} min, crontab)` : 'off';
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', WIN_TASK], { stdio: 'ignore' });
      return `on (every ${INTERVAL_MIN} min, Task Scheduler)`;
    } catch {
      return 'off';
    }
  }
  return 'not supported on this OS';
}
