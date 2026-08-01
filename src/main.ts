import './style.css';
import 'highlight.js/styles/github-dark.css';
import { registerSW } from 'virtual:pwa-register';
import { store } from './state';
import { mount } from './ui';
import { applyTheme } from './theme';
import { startSync } from './sync';

// Register the service worker and AUTO-APPLY updates.
//
// registerType is 'autoUpdate', so vite-plugin-pwa installs its own listener that does
// location.reload() as soon as a new worker activates. The piece that was missing is
// that a new worker is only ever DISCOVERED on a real document load — and an installed
// Android PWA resumed from the task switcher never performs one. A phone that is never
// cold-started therefore runs a stale build forever. So we re-check explicitly on
// resume, on regaining network, and hourly. Never while a reply is streaming, because
// activation triggers a reload that would kill the in-flight response.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    if (!r) return;
    const check = () => {
      if (!navigator.onLine || store.streaming) return;
      r.update().catch(() => { /* offline or transient — try again next time */ });
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
    setInterval(check, 60 * 60 * 1000);
  },
});

const root = document.getElementById('app')!;

(async () => {
  await store.init();
  applyTheme(store.settings.theme ?? 'dark');
  mount(root);
  // Multi-device sync (no-op unless enabled in Settings). Never blocks the UI.
  startSync().catch(() => { /* sync is best-effort */ });
})();
