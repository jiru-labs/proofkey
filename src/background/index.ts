import { hasScriptingApi } from '../core/browser';
import { loadSettings, resolveActions } from '../core/storage';

// Provider adapters and the full context-menu / injection wiring land in the
// next step. This file currently only proves the module graph and the MV3
// service-worker registration.

chrome.runtime.onInstalled.addListener(() => {
  void rebuildContextMenus();
});

async function rebuildContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const settings = await loadSettings();

  chrome.contextMenus.create({
    id: 'proofkey:root',
    title: 'ProofKey',
    contexts: ['selection', 'editable'],
  });

  for (const action of resolveActions(settings)) {
    if (!action.enabled) continue;
    chrome.contextMenus.create({
      id: `proofkey:action:${action.id}`,
      parentId: 'proofkey:root',
      title: action.label,
      contexts: ['selection', 'editable'],
    });
  }

  if (!hasScriptingApi()) {
    console.warn('[ProofKey] chrome.scripting is unavailable; injection is disabled.');
  }
}
