/** Dependencies of {@link ensureInjected}; the worker wires them to chrome.*. */
export interface InjectionDeps {
  /** Whether a live content script answers in the target frame. */
  ping(): Promise<boolean>;
  /** Injects into the frames that carry no marker; true when it injected anywhere. */
  injectBare(): Promise<boolean>;
  /** Injects into the target frame whatever the page's marker says. */
  injectTarget(): Promise<void>;
}

/**
 * Gets a live content script into the target frame. The probe behind
 * `injectBare` trusts the `#proofkey-root` marker, and after an extension
 * update the marker outlives the script that made it, so a ping that still
 * fails afterwards means an orphan: inject into the frame regardless.
 */
export async function ensureInjected(deps: InjectionDeps): Promise<'present' | 'injected'> {
  if (await deps.ping()) return 'present';
  const injected = await deps.injectBare();
  if (await deps.ping()) return injected ? 'injected' : 'present';
  await deps.injectTarget();
  return 'injected';
}
