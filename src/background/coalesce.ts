/**
 * Runs an async job one pass at a time, folding every call that arrives while
 * a pass is already waiting into that waiting pass.
 *
 * `syncRegistration` needs this. It reads the settings, then asks the browser
 * about each origin, then registers or unregisters -- and it is fired from
 * storage, permission and lifecycle events that can land together. Two passes
 * running side by side could finish in the wrong order: a pass that read the
 * old settings stalled in `permissions.contains`, the pass for the new settings
 * unregistered, and then the old pass registered the old origins back. That is
 * the extension test's intermittent "removing the origin unregisters it again"
 * failure (measured 11-04 to 11-10: the origins left registered were exactly
 * the set before the clear).
 *
 * A call made while a pass runs starts a fresh pass after it, so the last
 * settings written are always the last ones read. Calls made while that fresh
 * pass is still queued share it: it has not read anything yet, so it will see
 * their change too.
 *
 * No imports, so the Node checks can load it (tools/registration-check.ts).
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let queued: Promise<void> | null = null;
  return () => {
    if (queued) return queued;
    const next = tail.then(() => {
      queued = null;
      return run();
    });
    queued = next;
    // A failed pass rejects for its own callers but must not stall the chain.
    tail = next.catch(() => {});
    return next;
  };
}
