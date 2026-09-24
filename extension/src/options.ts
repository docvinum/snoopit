/** The pairing page: stores the token and port, and shows the connection status. */

import { DEFAULT_EXTENSION_PORT } from '../../src/runtime/browser/extension/protocol.js';

const tokenInput = document.getElementById('token') as HTMLInputElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const statusBox = document.getElementById('status') as HTMLDivElement;

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get<{ token?: string; port?: number }>([
    'token',
    'port',
  ]);
  tokenInput.value = stored.token ?? '';
  portInput.value = String(stored.port ?? DEFAULT_EXTENSION_PORT);
  await showStatus();
}

async function showStatus(): Promise<void> {
  const { status, statusAt } = await chrome.storage.session.get<{
    status?: string;
    statusAt?: string;
  }>(['status', 'statusAt']);
  statusBox.textContent =
    status === undefined ? 'En attente de snoopit.' : `${status} (${statusAt ?? ''})`;
}

document.getElementById('save')!.addEventListener('click', () => {
  void (async (): Promise<void> => {
    const token = tokenInput.value.trim();
    if (token.length < 32) {
      statusBox.textContent = 'Le jeton doit faire au moins 32 caractères.';
      return;
    }
    await chrome.storage.local.set({
      token,
      port: Number(portInput.value) || DEFAULT_EXTENSION_PORT,
    });
    await chrome.runtime.sendMessage({ type: 'reconnect' });
    statusBox.textContent = 'Enregistré. Connexion au prochain passage de snoopit.';
  })();
});

chrome.storage.session.onChanged.addListener(() => void showStatus());
void load();
