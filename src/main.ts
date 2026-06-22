import './style.css';
import 'highlight.js/styles/github-dark.css';
import { store } from './state';
import { mount } from './ui';
import { applyTheme } from './theme';
import { startSync } from './sync';

const root = document.getElementById('app')!;

(async () => {
  await store.init();
  applyTheme(store.settings.theme ?? 'dark');
  mount(root);
  // Multi-device sync (no-op unless enabled in Settings). Never blocks the UI.
  startSync().catch(() => { /* sync is best-effort */ });
})();
