// Theme handling. The resolved theme ('light' | 'dark') is written to
// <html data-theme="…"> and mirrored to localStorage so the inline boot script
// in index.html can apply it before first paint (no flash-of-wrong-theme).

export type ThemePref = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'bubble-theme';
let systemMql: MediaQueryList | null = null;

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'auto') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref;
}

export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* private mode */ }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#faf9f5' : '#1a1a1a');

  // When in 'auto', follow live OS theme changes.
  if (!systemMql) {
    systemMql = window.matchMedia('(prefers-color-scheme: light)');
    systemMql.addEventListener('change', () => {
      const cur = (localStorage.getItem(STORAGE_KEY) as ThemePref) || 'dark';
      if (cur === 'auto') applyTheme('auto');
    });
  }
}
