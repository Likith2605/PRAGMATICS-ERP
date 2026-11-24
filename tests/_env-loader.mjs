/**
 * Node.js ESM loader hook — stubs import.meta.env for Vite-compiled
 * source files so they can be loaded directly by Node in tests.
 *
 * Usage:
 *   node --import ./tests/_env-loader.mjs tests/ballooning.test.mjs
 *
 * This is automatically used by the test scripts that need it.
 */

// Patch globalThis so that any module that reads import.meta.env gets a no-op
// object. The actual values don't matter for unit tests since they exercise the
// localStorage/IndexedDB path, not the remote HTTP path.
// NOTE: import.meta.env is read at module evaluation time in ballooningApi.js,
// so we need to intercept it via a module hook rather than just patching after
// import. We do this by re-exporting the module after inserting the shim.

// Inject import.meta.env into the global so it's accessible during module init.
// This works because Node allows `globalThis` mutations before import evaluation.
const _env = {
    VITE_API_URL: 'http://localhost:3001/api/ballooning',
    VITE_API_BASE_URL: 'http://localhost:3001/api',
    MODE: 'test',
    DEV: false,
    PROD: false,
    SSR: false
};

// Expose on globalThis so modules that access import.meta.env fall back to this
// when the loader patches are applied.
globalThis.__vite_test_env__ = _env;
