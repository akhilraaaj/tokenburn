import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERVAL_MIN, renderPlist, renderSystemdUnits } from '../src/service.ts';

const cmd = ['/usr/local/bin/node', '/opt/tt/cli.mjs', 'sync', '--auto'];
const env = { HOME: '/Users/x', TOKENBURN_API_URL: 'https://a.example/?q=1&b=<2>' };

describe('automatic sync schedule', () => {
  it('launchd agent runs `sync --auto` every 30 min and at login, not resident, valid plist', () => {
    const plist = renderPlist(cmd, env, '/tmp/tt-sync.log');
    expect(plist).toContain(`<key>StartInterval</key><integer>${INTERVAL_MIN * 60}</integer>`);
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).not.toContain('KeepAlive');
    expect(plist).toContain('<string>sync</string><string>--auto</string>');
    expect(plist).toContain('&amp;b=&lt;2&gt;'); // escaped
    if (process.platform === 'darwin') {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-plist-')), 'x.plist');
      fs.writeFileSync(f, plist);
      expect(execFileSync('plutil', ['-lint', f], { encoding: 'utf8' })).toMatch(/OK/);
    }
  });

  it('systemd: oneshot service + persistent timer', () => {
    const { service, timer } = renderSystemdUnits(cmd, env, '/tmp/tt-sync.log');
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('ExecStart="/usr/local/bin/node" "/opt/tt/cli.mjs" "sync" "--auto"');
    expect(timer).toContain(`OnUnitActiveSec=${INTERVAL_MIN}min`);
    expect(timer).toContain('Persistent=true');
  });
});

import { assertSafeApiUrl } from '../src/sync.ts';

describe('server URL safety', () => {
  it('allows https anywhere and http only for localhost', () => {
    expect(() => assertSafeApiUrl('https://tokenburn.example')).not.toThrow();
    expect(() => assertSafeApiUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertSafeApiUrl('http://127.0.0.1:8787')).not.toThrow();
    expect(() => assertSafeApiUrl('http://tokenburn.example')).toThrow(/https/);
  });
});

import { renderCronLine, renderWindowsScript, windowsTaskArgs } from '../src/service.ts';

describe('Windows Task Scheduler', () => {
  const winCmd = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ann O\'Neil\\AppData\\Roaming\\npm\\node_modules\\tokenburn\\dist\\cli.mjs', 'sync', '--auto'];
  it('wrapper runs the sync hidden, logs, and escapes quotes for VBScript', () => {
    const vbs = renderWindowsScript(winCmd, { HOME: 'x', TOKENBURN_HOME: 'C:\\tt "q"' }, 'C:\\Users\\a\\.tokenburn\\sync.log');
    expect(vbs).toContain('Set sh = CreateObject("WScript.Shell")');
    expect(vbs).toContain('env("TOKENBURN_HOME") = "C:\\tt ""q"""');
    // cmd /c ""node" "cli" sync --auto >> "log" 2>&1" with every quote doubled inside the VBS string literal:
    expect(vbs).toContain('sh.Run "cmd /c """"C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Ann O\'Neil\\AppData\\Roaming\\npm\\node_modules\\tokenburn\\dist\\cli.mjs"" sync --auto >> ""C:\\Users\\a\\.tokenburn\\sync.log"" 2>&1""", 0, True');
    expect(vbs).toContain('\r\n'); // CRLF for Windows Script Host
  });
  it('task runs every 30 minutes and replaces any existing task', () => {
    expect(windowsTaskArgs('C:\\x\\tokenburn-sync.vbs')).toEqual(['/Create', '/F', '/SC', 'MINUTE', '/MO', '30', '/TN', 'tokenburn sync', '/TR', 'wscript.exe "C:\\x\\tokenburn-sync.vbs"']);
  });
});

describe('Linux cron fallback', () => {
  it('runs every 30 minutes with env and safe quoting, tagged for removal', () => {
    const line = renderCronLine(['/usr/bin/node', "/home/o'neil/cli.mjs", 'sync', '--auto'], { HOME: '/home/o', TOKENBURN_HOME: '/home/o/.tt' }, '/home/o/.tt/sync.log');
    expect(line).toBe(`*/30 * * * * HOME='/home/o' TOKENBURN_HOME='/home/o/.tt' '/usr/bin/node' '/home/o'\\''neil/cli.mjs' 'sync' '--auto' >> '/home/o/.tt/sync.log' 2>&1 # tokenburn-auto-sync`);
  });
  it('the generated line actually runs under sh', () => {
    // A real log file, not /dev/stdout: on Linux, Node's child stdio is a socket, which sh can't reopen by path.
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cron-')), "sync it's.log");
    const line = renderCronLine([process.execPath, '-e', 'process.stdout.write(process.env.TOKENBURN_HOME)'], { TOKENBURN_HOME: "/tmp/it's ok" }, log);
    const command = line.replace(/^\*\/30 \* \* \* \* /, '').replace(/ # tokenburn-auto-sync$/, '');
    execFileSync('sh', ['-c', command]);
    expect(fs.readFileSync(log, 'utf8')).toBe("/tmp/it's ok");
  });
});
