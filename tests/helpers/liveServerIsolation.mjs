/**
 * Keeps a headless UI test away from the live ERP server.
 *
 * The app boots by calling `syncERPState()` + `pullRecordsFromServer()`
 * (src/App.jsx), which overwrite localStorage with whatever PostgreSQL on
 * localhost:3001 holds. A test that seeds its own fixtures would have them
 * replaced a moment later, so assertions on seeded records fail and — worse —
 * the fixtures themselves get pushed into the real database.
 *
 * `LIVE_SERVER_ISOLATION_SCRIPT` is injected with
 * `Page.addScriptToEvaluateOnNewDocument` BEFORE any application code, so it
 * runs first: it makes `fetch()` reject for the state/records sync endpoints
 * (the sync layers treat that as "server offline" and keep the local copy)
 * and neutralises the unload `sendBeacon` that would otherwise still write the
 * fixtures to PostgreSQL.
 *
 * Everything else — file uploads, quality API, the test's own static server —
 * is left untouched.
 *
 * Usage:
 *   import { LIVE_SERVER_ISOLATION_SCRIPT } from './helpers/liveServerIsolation.mjs';
 *   await send('Page.addScriptToEvaluateOnNewDocument', {
 *     source: `\n      ${LIVE_SERVER_ISOLATION_SCRIPT}\n      ...seed code...\n    `
 *   });
 */
export const LIVE_SERVER_ISOLATION_SCRIPT = `
        /* ---- live-server isolation (see tests/helpers/liveServerIsolation.mjs) ---- */
        (() => {
          const BLOCKED = /localhost:3001\\/api\\/(state|records)(\\/|\\?|$)/;
          const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
          if (nativeFetch) {
            window.fetch = (input, init) => {
              const url = typeof input === 'string' ? input : (input && input.url) || '';
              if (BLOCKED.test(String(url))) {
                return Promise.reject(new TypeError('Failed to fetch (test isolation: live ERP server unreachable)'));
              }
              return nativeFetch(input, init);
            };
          }
          if (navigator.sendBeacon) {
            const nativeBeacon = navigator.sendBeacon.bind(navigator);
            navigator.sendBeacon = (url, data) =>
              BLOCKED.test(String(url)) ? false : nativeBeacon(url, data);
          }
        })();
        /* ---- end live-server isolation ---- */
`;
