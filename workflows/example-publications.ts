/**
 * Workflow `collect` : récupérer les publications PDF d'un site.
 *
 * Illustre la séparation découverte / collecte : la page d'index alimente la
 * frontier, puis une seconde phase consomme cette frontier et télécharge. Cette
 * séparation est ce qui rend la reprise, la priorisation et la déduplication
 * possibles (spec §15).
 */

import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'example-publications',
  type: 'collect',
  description: 'Collecte les nouvelles publications PDF et conserve leur provenance',
  budget: { maxPages: 50, maxDuration: '10m', maxDownloadBytes: 50_000_000 },

  async run(ctx) {
    const startUrl =
      process.env['SNOOPIT_PUBLICATIONS_START_URL'] ?? 'http://127.0.0.1:8080/index.html';

    // ── Phase 1 : découverte ────────────────────────────────────────────────
    const { page } = await ctx.visit(startUrl, { waitFor: '.publication-list' });

    const banner = await page.query('#cookie-banner');
    if (banner !== null && banner.view.display !== 'none') {
      await page.click('#accept-cookies');
    }

    const publications = await ctx.extract(page, {
      selector: '.publication',
      fields: { title: '.title', page: '.title@href', date: '.date', pdf: '.download@href' },
    });

    let discovered = 0;
    for (const publication of publications) {
      if (publication.pdf === null) continue;
      const isNew = ctx.frontier.discover(publication.pdf, {
        kind: 'document',
        // La date pilote la priorité : les publications récentes d'abord.
        priority: publication.date === null ? 100 : 50,
        meta: {
          title: publication.title,
          date: publication.date,
          foundOn: page.url(),
        },
      });
      if (isNew) discovered += 1;
    }

    await page.close();

    // ── Phase 2 : collecte ──────────────────────────────────────────────────
    // Une page distincte : la collecte consomme la frontier, elle ne dépend plus
    // de l'état de la page d'index.
    const collector = await ctx.browser.open(startUrl);
    const collected: { title: string | null; path: string; bytes: number | null }[] = [];

    try {
      for (const entry of ctx.frontier.take(50)) {
        try {
          const { artifact, deduplicated } = await ctx.artifacts.collect(collector, entry.url, {
            dir: 'publications',
          });
          if (!deduplicated) {
            collected.push({
              title: (entry.meta?.['title'] as string | undefined) ?? null,
              path: artifact.path,
              bytes: artifact.bytes,
            });
          }
          ctx.frontier.complete(entry);
        } catch (error) {
          // Un document illisible ne fait pas échouer la collecte entière : il est
          // marqué en échec, rapporté, et retenté au prochain run.
          ctx.frontier.fail(entry, error instanceof Error ? error.message : String(error));
          ctx.events.emit({
            type: 'HTTP_ERROR',
            level: 'error',
            url: entry.url,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await collector.close();
    }

    const summary = {
      startUrl,
      publicationsSeen: publications.length,
      discovered,
      collected: collected.length,
      remaining: ctx.frontier.remaining(),
    };

    await ctx.artifacts.writeJson('publications.json', { summary, collected });

    return summary;
  },
});
