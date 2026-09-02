/**
 * Workflow `collect` : un site dont le contenu est masqué par une modale.
 *
 * Illustre le pattern attendu (spec §5) :
 *
 * ```text
 * script -> script -> état inattendu -> recovery -> retour au script
 * ```
 *
 * Le recovery est un **garde**, pas une étape : `ctx.recover()` rend la main
 * immédiatement quand l'état attendu est déjà là, donc en protéger une action ne
 * coûte rien sur le chemin nominal. Avec `maxLlmCalls: 0`, ce workflow déclare qu'il
 * doit se débrouiller sans modèle — les heuristiques L1 suffisent pour une modale.
 */

import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'example-gated',
  type: 'collect',
  description: 'Collecte derrière une modale, franchie par heuristique déterministe',
  budget: { maxPages: 20, maxDuration: '5m', maxLlmCalls: 0 },

  async run(ctx) {
    const startUrl = process.env['SNOOPIT_GATED_URL'] ?? 'http://127.0.0.1:8080/gated.html';

    const { page } = await ctx.visit(startUrl);

    // L'état attendu n'est pas là : la modale le masque. Le recovery le rétablit
    // sans appel LLM, puis le script déterministe reprend exactement où il en était.
    const recovery = await ctx.recover(page, {
      goal: 'Accéder à la liste des publications',
      expectedState: { selector: '.publication-list' },
      allowedActions: ['click', 'scroll', 'close_overlay'],
      maxSteps: 4,
    });

    const publications = await ctx.extract(page, {
      selector: '.publication',
      fields: { title: '.title', pdf: '.download@href' },
    });

    for (const publication of publications) {
      if (publication.pdf === null) continue;
      ctx.frontier.discover(publication.pdf, { kind: 'document' });
    }

    let collected = 0;
    for (const entry of ctx.frontier.take(20)) {
      const { deduplicated } = await ctx.artifacts.collect(page, entry.url, {
        dir: 'publications',
      });
      if (!deduplicated) collected += 1;
      ctx.frontier.complete(entry);
    }
    await page.close();

    return {
      startUrl,
      recoveredAt: recovery.level,
      llmCalls: recovery.llmCalls,
      publications: publications.length,
      collected,
    };
  },
});
