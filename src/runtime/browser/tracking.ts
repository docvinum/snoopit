/**
 * Remembering which pages a run opened, so none outlives it.
 *
 * The Chrome we drive is persistent: a tab a workflow forgets to close — typically
 * because it threw before its `finally` — stays open after the run, and the next
 * run adds its own. Over weeks that is hundreds of tabs in a browser nobody looks
 * at. The runner wraps the backend it hands to a workflow in this tracker and
 * closes whatever is still open when the run ends, whatever the outcome.
 */

import type { BrowserBackend, OpenOptions, PageHandle } from './types.js';

export class PageTracker implements BrowserBackend {
  private readonly pages: PageHandle[] = [];

  constructor(private readonly inner: BrowserBackend) {}

  async open(url: string, options?: OpenOptions): Promise<PageHandle> {
    // `open` is `newPage` + `navigate`, spelled out so a page whose navigation
    // throws is still tracked and closed.
    const page = await this.newPage(options);
    await page.navigate(url, options);
    return page;
  }

  async newPage(options?: OpenOptions): Promise<PageHandle> {
    const page = await this.inner.newPage(options);
    this.pages.push(page);
    return page;
  }

  /** Pages opened through this tracker and not closed yet. */
  openPages(): PageHandle[] {
    return this.pages.filter((page) => !page.isClosed());
  }

  /**
   * Closes every page still open. Never throws: this runs while a run is being
   * wrapped up, and a tab that refuses to close must not cost the run its report.
   *
   * @returns how many pages had been left open.
   */
  async closeAll(): Promise<number> {
    const open = this.openPages();
    await Promise.allSettled(open.map((page) => page.close()));
    return open.length;
  }

  /** The shared backend belongs to the caller, not to the run: left untouched. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
