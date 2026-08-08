# Privacy Policy

**Last updated: 8 August 2026**

ProofKey is a browser extension published by Jiru Labs. This policy describes
what it does with your data. It is short because the extension does very little.

## The short version

ProofKey has no backend. There is no ProofKey server, no ProofKey account, and
no analytics. Jiru Labs does not receive your text, your API keys, or any record
that you used the extension.

## What leaves your browser, and where it goes

When you run an action, ProofKey sends the text you selected — or the sentence
you just finished typing — to **the LLM provider you configured, at the base URL
you configured**, using **your own API key**. That request goes directly from
your browser to that provider. It does not pass through any machine operated by
Jiru Labs.

Which provider that is, is entirely your choice. If you point ProofKey at a
local model such as Ollama, nothing leaves your machine at all.

**Your text is then subject to that provider's privacy policy, not this one.**
Providers differ enormously in whether they retain prompts or train on them.
That is worth reading before you paste anything confidential into a field on a
site where ProofKey is enabled.

## What is stored, and where

Stored using the browser's own extension storage, on your device:

- your API keys and connection settings (base URL, model, headers);
- your actions and their prompts, including any you wrote;
- your keyboard shortcuts and the list of origins they run on;
- your writing profile: style guide, terms never to flag, first language.

If you have Chrome Sync switched on, Chrome may sync some of this between your
own signed-in browsers. That is Chrome's mechanism and Chrome's policy; ProofKey
neither operates nor can read that channel.

Nothing is stored anywhere else. Uninstalling the extension removes it.

## What ProofKey does not do

- No telemetry, analytics, crash reporting, or usage statistics.
- No advertising, and no data sold, rented, or shared with third parties.
- No reading of pages you have not enabled it on.
- No collection of browsing history, credentials, or form data.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | To keep the settings listed above on your device |
| `contextMenus` | To put the actions on the right-click menu |
| `activeTab` | To read the text you selected, on the tab you invoked it from |
| `scripting` | To place the assistant into the field you are typing in |
| Host permissions | Requested **per site, by you**, and only for the sites where you want live checking or per-action shortcuts. Not requested up front and not granted for all sites |

## If this ever changes

If Jiru Labs ever offers an optional paid or hosted feature, it would be exactly
that — optional, off by default, and described here before it ships. The
extension's default behaviour, as described above, is not going to start sending
your writing somewhere else. If that ever changed, it would be a new major
version, announced in the changelog, and it would still require you to turn it
on.

## Contact

Questions, or a privacy problem to report:
[open an issue](https://github.com/jiru-labs/proofkey/issues), or email
`help@jirulabs.com` if you would rather not do it in public.

The extension is open source and MIT licensed. If you would rather verify this
policy than trust it, the code is at
[github.com/jiru-labs/proofkey](https://github.com/jiru-labs/proofkey).
