import './style.css';
import 'highlight.js/styles/github-dark.css';
import { registerSW } from 'virtual:pwa-register';
import { store } from './state';
import { mount } from './ui';
import { applyTheme } from './theme';
import { startSync } from './sync';

// Register the service worker and AUTO-APPLY updates. Without this, the SW caches the
// app but never updates it — every deploy is invisible until the cache is manually
// cleared. immediate:true checks on load; onNeedRefresh reloads to the new build.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() { updateSW(true); },
});

const root = document.getElementById('app')!;

(async () => {
  await store.init();
  applyTheme(store.settings.theme ?? 'dark');
  mount(root);
  // Multi-device sync (no-op unless enabled in Settings). Never blocks the UI.
  startSync().catch(() => { /* sync is best-effort */ });
})();
