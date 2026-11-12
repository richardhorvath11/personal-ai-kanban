// Runtime configuration. Everything is local: the service binds to loopback only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'real' | 'demo';

export interface Settings {
  timezone: string;
  reviewIntervalMinutes: number;
  staleDays: number; // no meaningful progress for this long => "neglected"
  deadlineSoonDays: number; // firm deadlines within this window are urgent
  reviewPendingDays: number; // a card in Review this long needs attention
}

export interface Config {
  mode: Mode;
  dataDir: string;
  host: '127.0.0.1';
  port: number;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: process.env.KANBAN_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  reviewIntervalMinutes: 5,
  staleDays: 3,
  deadlineSoonDays: 3,
  reviewPendingDays: 2,
};

export function defaultDataDir(mode: Mode): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'personal-ai-kanban', mode === 'demo' ? 'demo' : 'real');
}

export function loadConfig(overrides: Partial<Pick<Config, 'mode' | 'dataDir' | 'port'>> = {}): Config {
  const mode: Mode = overrides.mode ?? (process.env.KANBAN_MODE === 'demo' ? 'demo' : 'real');
  const dataDir = path.resolve(overrides.dataDir ?? process.env.KANBAN_DATA_DIR ?? defaultDataDir(mode));
  const port = overrides.port ?? Number(process.env.KANBAN_PORT || (mode === 'demo' ? 4318 : 4317));
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  let fileSettings: Partial<Settings> = {};
  if (fs.existsSync(settingsFile)) {
    try { fileSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* ignore malformed */ }
  } else {
    fs.writeFileSync(settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2) + '\n');
  }
  return { mode, dataDir, host: '127.0.0.1', port, settings: { ...DEFAULT_SETTINGS, ...fileSettings } };
}

export function serviceUrl(port?: number): string {
  if (process.env.KANBAN_URL) return process.env.KANBAN_URL.replace(/\/$/, '');
  return `http://127.0.0.1:${port ?? Number(process.env.KANBAN_PORT || 4317)}`;
}
