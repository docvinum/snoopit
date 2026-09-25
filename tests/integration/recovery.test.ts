import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { RecoveryFailedError, recover } from '../../src/runtime/recovery/recover.js';
import { buildFakeSite } from '../support/fake-site.js';

describe('deterministic recovery', () => {
  it('dismisses a known overlay and returns when the expected state becomes usable', async () => {
    const backend = new FakeBackend(buildFakeSite());
    const page = await backend.open('http://127.0.0.1:9999/gated.html');

    const outcome = await recover(page, {
      goal: 'read the publication list',
      expectedState: { selector: '.publication-list' },
    });

    expect(outcome).toMatchObject({ recovered: true, level: 'L1' });
    expect(outcome.steps).toContainEqual(
      expect.objectContaining({ action: 'close_overlay', target: '#confirm-age' }),
    );
    await page.close();
  });

  it('fails explicitly after the allowed deterministic actions are exhausted', async () => {
    const backend = new FakeBackend(buildFakeSite());
    const page = await backend.open('http://127.0.0.1:9999/index.html');

    await expect(
      recover(page, {
        goal: 'find an element that is absent',
        expectedState: { selector: '#not-present' },
        allowedActions: [],
      }),
    ).rejects.toBeInstanceOf(RecoveryFailedError);
    await page.close();
  });
});
