# Privacy Policy

**Last updated: 23 November 2026**

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

**Chrome's built-in model sends nothing.** In Google Chrome, a fresh install of
ProofKey uses the language model Chrome keeps on your computer. Your text is
handed to Chrome on the same machine and the check runs there; ProofKey makes no
network request for it. Chrome downloads that model once, from Google, when you
click **Download model**. What Chrome itself records about the download or about
using its model is governed by Google's Chrome privacy notice, not by this
policy.

**A model inside the browser sends nothing either** (since version 0.1.11). For browsers without Chrome's model, such as Brave, ProofKey can
run a language model itself, on your computer's GPU. Your text never leaves the
browser for it. The model's files are downloaded once — 2.4 GB, from
`huggingface.co`, pinned to one published revision — and only when you click **Download model** in
settings; ProofKey says the size and the host on that button before anything is
fetched. That download is a request from your browser to Hugging Face, which
sees it as any website sees a visit, under Hugging Face's own privacy policy. No
text you check is part of it, and nothing is fetched again after it.

**Your text is then subject to that provider's privacy policy, not this one.**
Providers differ enormously in whether they retain prompts or train on them.
That is worth reading before you paste anything confidential into a field on a
site where ProofKey is enabled.

## What is stored, and where

Stored using the browser's own extension storage, on your device:

- your API keys and connection settings (base URL, model, headers);
- your actions and their prompts, including any you wrote;
- your keyboard shortcuts and the list of origins they run on;
- your writing profile: style guide, terms never to flag, first language,
  and the regional variety you chose for English or Spanish, if any;
- if you downloaded the in-browser model, its files, in the browser's storage
  for the extension. **Remove the downloaded model** in settings deletes them.

**Your settings stay on this computer** (from 0.1.27): all of the above is
kept in `chrome.storage.local`, which never syncs (`src/core/storage.ts`), and
each API key in its own record there, by connection. To move your settings to
another computer, **Export to a file** in settings writes them to a file on
your disk and **Import from a file** reads it back; ProofKey sends that file
nowhere. It holds no API key, and none of the header, query or body fields you
added yourself, unless you tick the box that includes them.

Up to 0.1.26, every setting except the keys was kept in `chrome.storage.sync`.
If your browser's own sync was switched on for extensions, the browser copied
them — with every API key emptied — through its sync service to your other
copies of the same browser: Chrome through your Google account, Brave through
Brave Sync, and other browsers through their own. That is the browser's
mechanism and its provider's policy; ProofKey neither operates nor can read
that channel. The first time 0.1.27 runs, it copies the settings from there to
`chrome.storage.local` and from then on reads and writes only there. It leaves
the synced copy in place for your computers that have not updated yet; a later
version removes it.

Up to 0.1.18, the keys were also kept in `chrome.storage.sync` and travelled
with the rest. From 0.1.19, each key found there moves into
`chrome.storage.local` and the synced settings are rewritten without it; 0.1.27
does the same for any it still finds when it copies the settings.

One more thing is kept, in `chrome.storage.local`, which never syncs: how many
suggestions you have applied, when you applied the first, and whether ProofKey
has asked you to rate it (`src/core/review.ts`). It exists for one purpose —
asking **once**, after at least 10 applied suggestions over at least two days,
whether you would leave a rating in the Chrome Web Store — and it is never sent
anywhere. Clicking **Rate ProofKey** opens the store's reviews page in a new
tab; nothing else happens, and ignoring it means it is not asked again.

Also in `chrome.storage.local`: which "New in ProofKey" notes this computer has
shown, and when the last one was (`src/core/news.ts`). The notes are part of the
extension itself — nothing is fetched to show one — and this list exists only so
each is shown once, at most one a day, and never to a fresh install. It is never
sent anywhere.
One note points to the report forms: its **Report** button opens GitHub's site
report form in a new tab, with only the ProofKey version filled in — not the
page you were on. Nothing is sent unless you submit that form yourself.

Nothing is stored anywhere else. Uninstalling the extension removes it.

## What ProofKey does not do

- No telemetry, analytics, crash reporting, or usage statistics. The one count
  described above stays on your device and is only read by ProofKey itself.
- No advertising, and no data sold, rented, or shared with third parties.
- No reading of pages you have not enabled it on.
- No collection of browsing history, credentials, or form data.

## Threat model

What ProofKey protects you from, and what it does not, in the terms
[Privacy Guides uses for common threats](https://www.privacyguides.org/en/basics/common-threats/).

**It protects against:**

- **Surveillance as a business model**, on the part of the tool itself. Jiru Labs
  runs no server for ProofKey: no text, key, setting or usage count reaches us,
  because there is nowhere for it to go. The code is MIT licensed, so this can
  be checked rather than taken on trust.
- **Privacy from service providers**, as far as you choose it. With Chrome's
  built-in model or the in-browser model, ProofKey sends your text nowhere: the
  check runs on your computer. With a llama.cpp server you host, it goes only to
  that server. Nothing in between is ours.
- **Pages reading more than you meant.** No site access is granted at install.
  ProofKey reads a page only where you switched it on, one site at a time.

**It does not protect against:**

- **The provider you pick.** With an API key, the text you check goes to that
  provider, under its own privacy policy, tied to your account and billing.
- **Your browser's own sync, up to 0.1.26.** Settings travelled through your
  browser's sync service (Google's, Brave's or another's) if its sync was on for
  extensions (see above); API keys did not from 0.1.19. From 0.1.27 nothing new
  is written there, and the old copy stays until a later version removes it.
- **A settings file you export.** It is an ordinary file on your disk. If you
  ticked the box that includes API keys, anyone who gets the file can use them.
- **The browser and the page.** Chrome's built-in model is Chrome's code; the
  site you type into already sees what you type there; another extension, or
  malware on the device, can read the same fields ProofKey does.
- **Being identified.** ProofKey is not an anonymity tool. A provider knows who
  holds the key, and the one model download from Hugging Face is seen by Hugging
  Face like any visit.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `storage` | To keep the settings listed above on your device |
| `contextMenus` | To put the actions on the right-click menu |
| `activeTab` | To read the text you selected, on the tab you invoked it from |
| `scripting` | To place the assistant into the field you are typing in |
| `offscreen` | To run the in-browser model in a hidden extension page, if you choose that model. It reads no page and makes no request except the one download described above |
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
`info@jirulabs.com` if you would rather not do it in public.

The extension is open source and MIT licensed. If you would rather verify this
policy than trust it, the code is at
[github.com/jiru-labs/proofkey](https://github.com/jiru-labs/proofkey).
