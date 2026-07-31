import { groupedPresets } from '../core/storage';

// The full settings UI (connection list, dynamic preset fields, prompt editor)
// lands in a later step.

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  const { primary, more } = groupedPresets();
  app.textContent = `${primary.length + more.length} providers available.`;
}
