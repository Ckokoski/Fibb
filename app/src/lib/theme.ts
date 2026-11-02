export type Theme = 'dark' | 'light' | 'system';
const KEY = 'fibb_theme';

export function getTheme(): Theme {
  try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' || v === 'system' ? v : 'system'; } catch { return 'system'; }
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function cycleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark';
}
