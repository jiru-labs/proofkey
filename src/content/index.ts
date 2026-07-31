import css from './ui.css?inline';

// The inline assistant (field detection, underline overlay, suggestion card)
// lands in a later step. For now this only establishes the isolated UI root.

const HOST_ID = 'proofkey-root';

function mountUiRoot(): ShadowRoot {
  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = css;
  shadow.append(style);

  document.documentElement.append(host);
  return shadow;
}

mountUiRoot();
