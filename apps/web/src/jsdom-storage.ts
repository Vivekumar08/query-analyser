/**
 * Test helper. Node 22+ defines its own global `localStorage` (undefined
 * unless started with --localstorage-file), and vitest's jsdom environment
 * does not overwrite globals Node already has — so in jsdom tests
 * `localStorage` is undefined. This installs jsdom's own Storage, which is
 * what a browser page would see. Call once at the top of a jsdom test file.
 */
export function installJsdomLocalStorage(): void {
  const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
  if (!dom) throw new Error('installJsdomLocalStorage needs the jsdom environment');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: dom.window.localStorage });
}
