/**
 * Opt-in OS toast (C7/#77; spec §3c). Dependency-free Windows notification via a
 * PowerShell NotifyIcon balloon — no BurntToast module, no npm dependency. OFF by
 * default (a user-enabled hook), and best-effort: any failure is swallowed so a
 * missing PowerShell / non-Windows host never breaks the console. Not push: you
 * must have opted in on this machine (true phone push stays the Firebase step).
 */
import { spawn } from 'node:child_process';

/** Build the PowerShell one-liner that pops a tray balloon. Values are single-quote-escaped. */
export function balloonScript(title, body) {
  const q = (s) => String(s ?? '').replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$n = New-Object System.Windows.Forms.NotifyIcon;',
    '$n.Icon = [System.Drawing.SystemIcons]::Warning;',
    '$n.Visible = $true;',
    `$n.ShowBalloonTip(6000, '${q(title)}', '${q(body)}', [System.Windows.Forms.ToolTipIcon]::Warning);`,
    'Start-Sleep -Milliseconds 6500; $n.Dispose();',
  ].join(' ');
}

/**
 * Fire one notification when enabled; a no-op otherwise. Best-effort — never
 * throws. spawnFn injected for tests. Returns {fired, reason?}.
 */
export function notify(title, body, { enabled = false, spawnFn = spawn, platform = process.platform } = {}) {
  if (!enabled) return { fired: false, reason: 'disabled' };
  if (platform !== 'win32') return { fired: false, reason: 'not-windows' };
  try {
    const child = spawnFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', balloonScript(title, body)], { detached: true, stdio: 'ignore' });
    child.unref?.();
    return { fired: true };
  } catch (e) {
    return { fired: false, reason: String(e?.message ?? e) };
  }
}
