/**
 * A real Lexical editor for the harness — the same library WhatsApp Web's
 * composer is built on.
 *
 * Two hand-written simulations of Lexical were wrong before this: the first
 * modelled DOM reconciliation, the second modelled its selection handling, and
 * neither reproduced the bug. Guessing at an editor's internals is not a test.
 * This bundles the actual editor so the apply path meets the real thing.
 */

import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import { registerPlainText } from '@lexical/plain-text';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';

declare global {
  interface Window {
    __pkLexicalText?: () => string;
  }
}

const host = document.getElementById('lexical');

if (host) {
  const editor = createEditor({
    namespace: 'proofkey-harness',
    onError: (error) => console.error('[lexical]', error),
  });

  editor.setRootElement(host);
  registerPlainText(editor);
  registerHistory(editor, createEmptyHistoryState(), 300);

  const seed = host.dataset['seed'] ?? '';
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const paragraph = $createParagraphNode();
    paragraph.append($createTextNode(seed));
    root.append(paragraph);
  });

  // Reads through Lexical's own model rather than the DOM, so the test sees
  // what the editor believes its content to be.
  window.__pkLexicalText = () =>
    editor.getEditorState().read(() => $getRoot().getTextContent());
}
