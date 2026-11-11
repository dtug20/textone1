// Diagnostic log shared by the service worker, offscreen document and popup.
// Entries never contain session tokens or caption `pot` values.
const LIMIT = 300;
const DEV_SINK = 'http://localhost:18810';
let chain = Promise.resolve();

export const isDevInstall = () => {
  try { return !('update_url' in chrome.runtime.getManifest()); } catch { return false; }
};

export function debugLog(event, data = {}) {
  const entry = { at: new Date().toISOString(), event, ...data };
  console.info('[TexTone]', event, data);
  chain = chain.then(async () => {
    const { debugLog: list = [] } = await chrome.storage.local.get('debugLog');
    list.push(entry);
    await chrome.storage.local.set({ debugLog: list.slice(-LIMIT) });
  }).catch(() => {});
  if (isDevInstall()) {
    void fetch(`${DEV_SINK}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }).catch(() => {});
  }
  return chain;
}

export const devSink = DEV_SINK;
