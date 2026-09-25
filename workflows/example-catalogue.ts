/**
 * Workflow `collect` : parcourir un grand catalogue **par tranches**.
 *
 * Illustre la visite partielle (spec §8) : chaque run ne traite qu'une partie du
 * catalogue, borné par le budget et par `pagesPerRun`, puis s'arrête proprement.
 * Le run suivant reprend là où celui-ci s'est arrêté — sans numéro de page, en
 * consommant simplement ce qui reste dans la frontier.
 *
 * C'est aussi le workflow du test d'acceptation du MVP : il doit survivre à un
 * `kill -9` en cours de collecte.
 */

import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'example-catalogue',
  type: 'collect',
  description: 'Collecte un catalogue volumineux par tranches, reprenable',
  budget: { maxPages: 10, maxDuration: '10m' },

  async run(ctx) {
    const startUrl = process.env['SNOOPIT_CATALOGUE_URL'] ?? 'http://127.0.0.1:8080/catalogue.html';

    // ── Découverte ──────────────────────────────────────────────────────────
    // Idempotente : au second run, le catalogue est reparcouru mais rien de connu
    // n'est remis en file.
    const { page } = await ctx.visit(startUrl, { waitFor: '.document-list' });

    const documents = await ctx.extract(page, {
      selector: '.document',
      fields: { title: '.title', date: '.date', pdf: '.download@href' },
    });

    for (const document of documents) {
      if (document.pdf === null) continue;
      ctx.frontier.discover(document.pdf, {
        kind: 'document',
        meta: { title: document.title, date: document.date },
      });
    }
    await page.close();

    // ── Collecte, une tranche à la fois ─────────────────────────────────────
    // `take` est déjà borné par le budget et par pagesPerRun : inutile de compter
    // ici, le runtime refuse de réserver du travail qu'il ne pourra pas finir.
    const collector = await ctx.browser.open(startUrl);
    const collected: string[] = [];

    try {
      let batch = ctx.frontier.take(5);
      while (batch.length > 0) {
        for (const entry of batch) {
          try {
            const { artifact, deduplicated } = await ctx.artifacts.collect(collector, entry.url, {
              dir: 'catalogue',
            });
            if (!deduplicated) collected.push(artifact.path);
            ctx.frontier.complete(entry);
          } catch (error) {
            ctx.frontier.fail(entry, error instanceof Error ? error.message : String(error));
          }
        }
        batch = ctx.frontier.take(5);
      }
    } finally {
      await collector.close();
    }

    return {
      startUrl,
      documentsSeen: documents.length,
      collected: collected.length,
      remaining: ctx.frontier.remaining(),
    };
  },
});
