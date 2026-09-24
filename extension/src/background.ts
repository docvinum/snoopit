/**
 * snoopit's extension: the service worker that executes a run's page operations.
 *
 * It connects to the loopback WebSocket snoopit opens for a run, proves it holds
 * the pairing token (and checks that snoopit does), then does what it is asked —
 * only in tabs it opened itself, in a window of its own. It never listens on a
 * port, never talks to anything but 127.0.0.1, and does nothing without a request.
 *
 * The page-side code is `page-functions.ts`, injected into the page's isolated
 * world: the same functions the CDP backend evaluates.
 */

import {
  DEFAULT_EXTENSION_PORT,
  PROTOCOL,
  proofMessage,
  type ExtensionMessage,
  type FetchWireResult,
  type NavigateResult,
  type Operation,
  type ServerMessage,
  type WireError,
} from '../../src/runtime/browser/extension/protocol.js';

const RECONNECT_ALARM = 'snoopit-connect';
const PAGE_LIBRARY = 'lib/page-functions.js';

// ─── Settings and state ─────────────────────────────────────────────────────

interface Settings {
  readonly token: string | null;
  readonly port: number;
}

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get<{ token?: string; port?: number }>([
    'token',
    'port',
  ]);
  return { token: stored.token ?? null, port: stored.port ?? DEFAULT_EXTENSION_PORT };
}

/**
 * Tabs this extension opened. Kept in session storage: a service worker can be
 * stopped and restarted between two requests, and must still refuse to touch any
 * tab that is not its own.
 */
async function ownTabs(): Promise<Set<number>> {
  const stored = await chrome.storage.session.get<{ tabs?: number[] }>('tabs');
  return new Set(stored.tabs ?? []);
}

async function setOwnTabs(tabs: Set<number>): Promise<void> {
  await chrome.storage.session.set({ tabs: [...tabs] });
}

async function assertOwnTab(tabId: number): Promise<void> {
  if (!(await ownTabs()).has(tabId)) {
    throw wire('Error', `Tab ${String(tabId)} was not opened by snoopit`);
  }
}

async function setStatus(status: string): Promise<void> {
  await chrome.storage.session.set({ status, statusAt: new Date().toISOString() });
}

// ─── Errors ───────────────────────────────────────────────────────────────────

class WireFailure extends Error {
  constructor(readonly wireError: WireError) {
    super(wireError.message);
  }
}

function wire(name: WireError['name'], message: string): WireFailure {
  return new WireFailure({ name, message });
}

function toWireError(error: unknown): WireError {
  if (error instanceof WireFailure) return error.wireError;
  return { name: 'Error', message: error instanceof Error ? error.message : String(error) };
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// ─── Connection ───────────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let connecting = false;

function send(message: ExtensionMessage): void {
  socket?.send(JSON.stringify(message));
}

async function connect(): Promise<void> {
  if (socket !== null || connecting) return;
  const { token, port } = await settings();
  if (token === null || token === '') {
    await setStatus('non appairée — saisissez le jeton dans les options');
    return;
  }

  connecting = true;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  let authenticated = false;
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}`);

  ws.onmessage = (event: MessageEvent<string>): void => {
    void (async (): Promise<void> => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === 'hello') {
        if (message.protocol !== PROTOCOL) {
          ws.close();
          return;
        }
        socket = ws;
        send({
          type: 'hello',
          protocol: PROTOCOL,
          nonce,
          proof: await hmac(token, proofMessage('extension', message.nonce)),
          version: chrome.runtime.getManifest().version,
        });
      } else if (message.type === 'welcome') {
        // snoopit proves it holds the token too: anything else on this port is not
        // given a browser to drive.
        if (message.proof !== (await hmac(token, proofMessage('server', nonce)))) {
          await setStatus('refusée — le serveur ne connaît pas le jeton');
          ws.close();
          return;
        }
        authenticated = true;
        await setStatus('connectée à snoopit');
      } else if (message.type === 'request') {
        if (!authenticated) {
          ws.close();
          return;
        }
        await handle(message.id, message.operation);
      }
    })();
  };

  ws.onclose = (): void => {
    const wasAuthenticated = authenticated;
    socket = null;
    connecting = false;
    if (wasAuthenticated) {
      void setStatus('en attente de snoopit');
      // A tick runs several jobs back to back, each opening the endpoint anew:
      // reconnect quickly while the worker is still alive.
      retrySoon();
    }
  };
  ws.onerror = (): void => {
    // Nothing listens: snoopit is not running a job. The alarm will try again.
  };
  ws.onopen = (): void => {
    connecting = false;
  };
}

function retrySoon(): void {
  for (const delay of [1_000, 3_000, 8_000]) {
    setTimeout(() => void connect(), delay);
  }
}

// ─── Operations ───────────────────────────────────────────────────────────────

async function handle(id: number, operation: Operation): Promise<void> {
  try {
    const result = await execute(operation);
    send({ type: 'response', id, ok: true, result: result ?? null });
  } catch (error) {
    send({ type: 'response', id, ok: false, error: toWireError(error) });
  }
}

async function execute(operation: Operation): Promise<unknown> {
  switch (operation.op) {
    case 'ping':
      return {};
    case 'newPage':
      return newPage(operation.viewport);
    case 'navigate':
      await assertOwnTab(operation.tabId);
      return navigate(operation.tabId, operation.url, operation.timeoutMs, operation.useHttpCache);
    case 'call':
      await assertOwnTab(operation.tabId);
      return callInPage(operation.tabId, operation.fn, operation.args, operation.timeoutMs);
    case 'screenshot':
      await assertOwnTab(operation.tabId);
      return screenshot(operation.tabId, operation.format, operation.box);
    case 'fetch':
      await assertOwnTab(operation.tabId);
      return fetchFor(operation.tabId, operation.url, operation.timeoutMs);
    case 'close':
      await assertOwnTab(operation.tabId);
      return closeTab(operation.tabId);
  }
}

/** The window snoopit works in, so its tabs never land among the person's. */
async function automationWindow(viewport: readonly [number, number] | null): Promise<number> {
  const stored = await chrome.storage.session.get<{ windowId?: number }>('windowId');
  if (stored.windowId !== undefined) {
    try {
      await chrome.windows.get(stored.windowId);
      return stored.windowId;
    } catch {
      /* closed by the person: open another */
    }
  }
  const created = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    ...(viewport === null ? {} : { width: viewport[0], height: viewport[1] }),
  });
  if (created?.id === undefined) throw wire('Error', 'Could not open the snoopit window');
  await chrome.storage.session.set({ windowId: created.id });
  return created.id;
}

async function newPage(viewport: readonly [number, number] | null): Promise<{ tabId: number }> {
  const windowId = await automationWindow(viewport);
  if (viewport !== null) {
    await chrome.windows.update(windowId, { width: viewport[0], height: viewport[1] });
  }
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
  // Let the initial about:blank finish, or its late "completed" event would be
  // mistaken for the end of the first real navigation.
  await tabSettled(tab.id!, 2_000);
  const tabs = await ownTabs();
  tabs.add(tab.id!);
  await setOwnTabs(tabs);
  return { tabId: tab.id! };
}

/**
 * Makes main-frame requests of this tab revalidate with the site instead of being
 * answered from Chrome's cache — what a reload does. A crawler deciding whether a
 * page changed must not be handed its own previous copy.
 */
async function setRevalidation(tabId: number, enabled: boolean): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: enabled
      ? [
          {
            id: tabId,
            priority: 1,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
              requestHeaders: [
                {
                  header: 'cache-control',
                  operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: 'no-cache',
                },
                {
                  header: 'pragma',
                  operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                  value: 'no-cache',
                },
              ],
            },
            condition: {
              tabIds: [tabId],
              resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
            },
          },
        ]
      : [],
  });
}

function navigate(
  tabId: number,
  url: string,
  timeoutMs: number,
  useHttpCache: boolean,
): Promise<NavigateResult> {
  return new Promise((resolve, reject) => {
    const chain: string[] = [];
    let status: number | null = null;
    const filter: chrome.webRequest.RequestFilter = {
      urls: ['<all_urls>'],
      tabId,
      types: ['main_frame'],
    };

    const onRedirect = (details: chrome.webRequest.OnBeforeRedirectDetails): void => {
      chain.push(details.url);
    };
    const onCompleted = (details: chrome.webRequest.OnCompletedDetails): void => {
      // A revalidated copy is the site's current content: report it as the 200 it is.
      status = details.statusCode === 304 ? 200 : details.statusCode;
    };
    const blankTarget = url.startsWith('about:');
    const onLoaded = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      // The document we left may still report its own load; only ours counts.
      if (!blankTarget && details.url.startsWith('about:')) return;
      void finish(null);
    };
    const onFailed = (
      details: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails,
    ): void => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      if (!blankTarget && details.url.startsWith('about:')) return;
      void finish(wire('NavigationError', `${details.error} for ${url}`));
    };

    let settled = false;
    const finish = async (error: WireFailure | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.webRequest.onBeforeRedirect.removeListener(onRedirect);
      chrome.webRequest.onCompleted.removeListener(onCompleted);
      chrome.webNavigation.onCompleted.removeListener(onLoaded);
      chrome.webNavigation.onErrorOccurred.removeListener(onFailed);
      if (error !== null) {
        reject(error);
        return;
      }
      const tab = await chrome.tabs.get(tabId);
      resolve({ url: tab.url ?? url, status, redirectChain: chain });
    };
    // Failure is explicit: a navigation that never completes is an error, never a
    // result that looks like success.
    const timer = setTimeout(() => {
      void finish(
        wire('NavigationTimeoutError', `Timed out after ${String(timeoutMs)}ms waiting for ${url}`),
      );
    }, timeoutMs);

    chrome.webRequest.onBeforeRedirect.addListener(onRedirect, filter);
    chrome.webRequest.onCompleted.addListener(onCompleted, filter);
    chrome.webNavigation.onCompleted.addListener(onLoaded);
    chrome.webNavigation.onErrorOccurred.addListener(onFailed);

    void setRevalidation(tabId, !useHttpCache)
      .then(() => chrome.tabs.update(tabId, { url }))
      .catch((error: unknown) => {
        void finish(
          wire('NavigationError', error instanceof Error ? error.message : String(error)),
        );
      });
  });
}

/** Runs in the page's isolated world: calls a page function by name. */
function dispatch(
  name: string,
  args: unknown[],
): { missing: true } | Promise<{ value: unknown; href: string }> {
  const library = (
    globalThis as unknown as { __snoopit?: Record<string, (...a: unknown[]) => unknown> }
  ).__snoopit;
  const fn = library?.[name];
  if (fn === undefined) return { missing: true };
  return Promise.resolve(fn(...args)).then((value) => ({
    value: value ?? null,
    href: location.href,
  }));
}

/** Resolves when the tab has finished loading, or when `ms` have passed. */
function tabSettled(tabId: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, change: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    });
  });
}

/**
 * Calls a page function, injecting the library when the document does not have it
 * yet. A call cut short by a navigation (the document it ran in went away) is
 * retried in the new document until its deadline.
 */
async function callInPage(
  tabId: number,
  fn: string,
  args: readonly unknown[],
  timeoutMs: number,
): Promise<{ value: unknown; href: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: dispatch,
        args: [fn, [...args]],
      });
      const result = frame?.result as
        { missing?: true; value?: unknown; href?: string } | null | undefined;
      if (result === null || result === undefined) {
        // The document went away while the call was running — a click that
        // navigated. Chrome reports that as an empty result, not an error: carry
        // on in the new document.
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw wire('CallTimeoutError', `${fn} did not complete in time`);
        await tabSettled(tabId, remaining);
        continue;
      }
      if (result.missing === true) {
        await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_LIBRARY] });
        continue;
      }
      return { value: result.value ?? null, href: result.href ?? '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const navigatedAway = /removed|unloaded|No frame|Frame with ID|document|back\/forward/i.test(
        message,
      );
      const remaining = deadline - Date.now();
      if (!navigatedAway || remaining <= 0) {
        if (remaining <= 0)
          throw wire('CallTimeoutError', `${fn} did not complete in time: ${message}`);
        throw error;
      }
      await tabSettled(tabId, remaining);
    }
  }
}

async function screenshot(
  tabId: number,
  format: 'png' | 'jpeg',
  box: { x: number; y: number; width: number; height: number } | null,
): Promise<{ dataBase64: string }> {
  // Only the visible tab of a window can be captured.
  const tab = await chrome.tabs.update(tabId, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab!.windowId, { format });
  if (box === null) return { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) };

  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(box.width, box.height);
  canvas
    .getContext('2d')!
    .drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const blob = await canvas.convertToBlob({ type: `image/${format}` });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { dataBase64: btoa(binary) };
}

/**
 * Downloads through the tab's session. Same origin as the page: fetched by the page
 * itself, with exactly its cookies. Another origin: fetched by the extension, whose
 * host permission carries the profile's cookies for that site.
 */
async function fetchFor(tabId: number, url: string, timeoutMs: number): Promise<FetchWireResult> {
  const tab = await chrome.tabs.get(tabId);
  const sameOrigin = tab.url !== undefined && new URL(tab.url).origin === new URL(url).origin;
  if (sameOrigin) {
    const { value } = await callInPage(tabId, 'fetchInPage', [url, timeoutMs], timeoutMs);
    return value as FetchWireResult;
  }
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { url: response.url, status: response.status, headers, bodyBase64: btoa(binary) };
}

async function closeTab(tabId: number): Promise<void> {
  const tabs = await ownTabs();
  tabs.delete(tabId);
  await setOwnTabs(tabs);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already gone */
  }
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  void ownTabs().then(async (tabs) => {
    if (!tabs.has(tabId)) return;
    tabs.delete(tabId);
    await setOwnTabs(tabs);
    send({ type: 'event', event: 'tabClosed', tabId });
  });
});

// Chrome wakes an idle worker for alarms; 30 s is the shortest period it allows.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
});

function ensureAlarm(): void {
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  // From the options page, after the token was saved.
  if (message.type === 'reconnect') {
    socket?.close();
    void connect();
  }
});

ensureAlarm();
void connect();
