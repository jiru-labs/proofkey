/**
 * Checks when a note about something new is shown, and to whom:
 *
 *     node --experimental-strip-types tools/news-check.ts
 *
 * Once per item, at most one a day, never to a fresh install, and never to
 * someone the item says nothing to.
 */

import type { Settings } from '../src/core/types.ts';
import {
  applyNewsAction,
  newsLink,
  emptyNewsState,
  installedNewsState,
  NEWS,
  NEWS_GAP_MS,
  takeNews,
  type NewsItem,
} from '../src/core/news.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const NOW = Date.UTC(2026, 10, 15);
const always = (id: string): NewsItem => ({ id, text: id, relevant: () => true });

/** The part of the settings a note reads, with the stored defaults. */
function defaultSettings(): Settings {
  return {
    liveCheck: {
      enabledOrigins: [],
      blockedOrigins: [],
      debounceMs: 1000,
      minChars: 12,
      maxSentencesPerRequest: 8,
      dictionary: [],
      autoCorrect: false,
    },
  } as unknown as Settings;
}

const user = defaultSettings();
user.liveCheck.enabledOrigins = ['https://mail.example'];

console.log('\nWho gets a note:');
const first = takeNews(emptyNewsState(), user, NOW);
check('an existing user with live checking on gets the automatic-correction note', first.item?.id === 'auto-correct', String(first.item?.id));
check('and it is marked seen as it is handed out', first.state.seen.includes('auto-correct') && first.state.lastShownAt === NOW);
check('so it is never handed out again', takeNews(first.state, user, NOW + 10 * NEWS_GAP_MS).item?.id !== 'auto-correct');
const second = takeNews(first.state, user, NOW + NEWS_GAP_MS);
check('a day later, the note about the report forms', second.item?.id === 'report-forms', String(second.item?.id));
check('and after both, nothing', takeNews(second.state, user, NOW + 10 * NEWS_GAP_MS).item === null);

const twoProviders = defaultSettings();
twoProviders.liveCheck.enabledOrigins = ['https://mail.example'];
twoProviders.connections = [{ id: 'one' }, { id: 'two' }] as unknown as Settings['connections'];
twoProviders.fallbackConnectionIds = [];
const third = takeNews(takeNews(second.state, twoProviders, NOW + 2 * NEWS_GAP_MS).state, twoProviders, NOW + 3 * NEWS_GAP_MS);
check('someone with two providers and no backup hears about Backup',
  takeNews(second.state, twoProviders, NOW + 2 * NEWS_GAP_MS).item?.id === 'backup', String(takeNews(second.state, twoProviders, NOW + 2 * NEWS_GAP_MS).item?.id));
check('and only once', third.item === null, String(third.item?.id));
const hasBackup = { ...twoProviders, fallbackConnectionIds: ['two'] } as Settings;
check('not someone who already has a backup', takeNews(second.state, hasBackup, NOW + 2 * NEWS_GAP_MS).item === null);

check('a fresh install gets none of what ships today', takeNews(installedNewsState(), user, NOW).item === null);

const on = defaultSettings();
on.liveCheck.enabledOrigins = ['https://mail.example'];
on.liveCheck.autoCorrect = true;
check('someone who already has it on is not told about it', takeNews(emptyNewsState(), on, NOW).item?.id !== 'auto-correct');
check('but does hear about the report forms', takeNews(emptyNewsState(), on, NOW).item?.id === 'report-forms');
check('nor someone who never switched live checking on', takeNews(emptyNewsState(), defaultSettings(), NOW).item === null);

console.log('\nHow often:');
const two = [always('a'), always('b')];
const a = takeNews(emptyNewsState(), user, NOW, two);
const sameDay = takeNews(a.state, user, NOW + NEWS_GAP_MS - 1, two);
const nextDay = takeNews(a.state, user, NOW + NEWS_GAP_MS, two);
check('two items in one release are not shown on the same day', a.item?.id === 'a' && sameDay.item === null, String(sameDay.item?.id));
check('the second comes a day later', nextDay.item?.id === 'b', String(nextDay.item?.id));
check('every item has a unique id', new Set(NEWS.map((item) => item.id)).size === NEWS.length);

console.log('\nThe button:');
const settings = defaultSettings();
check('Turn on switches automatic correction on', applyNewsAction(settings, 'auto-correct') && settings.liveCheck.autoCorrect === true);
check('an unknown action does nothing', !applyNewsAction(defaultSettings(), 'something-else'));
const untouched = defaultSettings();
check('Report changes no setting', !applyNewsAction(untouched, 'open-report') && untouched.liveCheck.autoCorrect === false);
const link = new URL(newsLink('open-report', '9.8.7') ?? 'about:blank');
check(
  'Report opens the site form with only the version filled in',
  link.origin + link.pathname === 'https://github.com/jiru-labs/proofkey/issues/new' &&
    [...link.searchParams.keys()].join() === 'template,version' &&
    link.searchParams.get('template') === 'site-report.yml' &&
    link.searchParams.get('version') === '9.8.7',
  link.href,
);
check('Turn on opens nothing', newsLink('auto-correct', '9.8.7') === null);

console.log(failures === 0 ? '\nNews checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
