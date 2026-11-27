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

// The browser/status-bar colour has to match the page background of the palette in use.
function paintChrome(): void {
  const { theme, mode } = document.documentElement.dataset;
  const colors = mode === 'gemini' ? { light: '#ffffff', dark: '#131314' } : { light: '#faf9f5', dark: '#1a1a1a' };
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? colors.light : colors.dark);
}

// Claude or Gemini palette (style.css keys off <html data-mode>). Mirrored to
// localStorage for the same reason as the theme: the boot script paints it first.
export function applyMode(mode: 'claude' | 'gemini'): void {
  document.documentElement.dataset.mode = mode;
  try { localStorage.setItem('bubble-mode', mode); } catch { /* private mode */ }
  paintChrome();
}

export function applyTheme(pref: ThemePref): void {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* private mode */ }
  paintChrome();

  // When in 'auto', follow live OS theme changes.
  if (!systemMql) {
    systemMql = window.matchMedia('(prefers-color-scheme: light)');
    systemMql.addEventListener('change', () => {
      const cur = (localStorage.getItem(STORAGE_KEY) as ThemePref) || 'dark';
      if (cur === 'auto') applyTheme('auto');
    });
  }
}
