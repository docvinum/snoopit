/**
 * Workflow `audit` : vérifier qu'un site répond correctement.
 *
 * Illustre le chemin nominal : navigation déterministe, checks explicites, rapport.
 * Aucun modèle n'est appelé : le runtime est entièrement déterministe.
 */

import { workflow } from '../src/runtime/workflow/types.js';

interface LinkCheck {
  readonly url: string;
  readonly label: string;
  readonly status: number | null;
  readonly redirectedTo: string | null;
  readonly ok: boolean;
}

export default workflow({
  name: 'example-audit',
  type: 'audit',
  description: "Vérifie les liens et les images d'un site de démonstration",
  budget: { maxPages: 20, maxDuration: '5m', maxErrors: 10 },

  async run(ctx) {
    const startUrl = process.env['SNOOPIT_AUDIT_START_URL'] ?? 'http://127.0.0.1:8080/index.html';

    const { page, navigation } = await ctx.visit(startUrl, { waitFor: '.publication-list' });

    // Une bannière cookies se ferme par heuristique déterministe.
    const banner = await page.query('#cookie-banner');
    if (banner !== null && banner.view.display !== 'none') {
      await page.click('#accept-cookies');
    }

    // Découverte : tous les liens internes de la page.
    const links = await ctx.extract(page, {
      selector: 'nav a, .publication .title',
      fields: { url: '@href', label: '@text' },
    });

    const internal = links.filter(
      (link) => link.url !== null && link.url.startsWith(new URL(startUrl).origin),
    );
    ctx.frontier.discoverAll(
      internal.map((link) => link.url!),
      { kind: 'page' },
    );

    // Collecte : visiter chaque lien découvert et relever son statut.
    const checks: LinkCheck[] = [];
    for (const entry of ctx.frontier.take(20)) {
      const visit = await ctx.visit(entry.url, { record: true });
      const redirected = visit.navigation.redirectChain.length > 0 ? visit.navigation.url : null;

      checks.push({
        url: entry.url,
        label: (entry.meta?.['label'] as string | undefined) ?? entry.url,
        status: visit.navigation.status,
        redirectedTo: redirected,
        ok: visit.navigation.ok,
      });

      await visit.page.close();
      ctx.frontier.complete(entry);
    }

    // Images : présentes dans le DOM mais éventuellement absentes du serveur.
    const images = await ctx.extract(page, { selector: 'img', fields: { src: '@src' } });
    const missingImages: string[] = [];
    for (const image of images) {
      if (image.src === null) continue;
      const response = await page.fetch(image.src);
      if (response.status !== 200) missingImages.push(image.src);
    }

    await ctx.artifacts.screenshot(page, 'start-page.png');
    await page.close();

    const broken = checks.filter((check) => !check.ok);
    const redirects = checks.filter((check) => check.redirectedTo !== null);

    const summary = {
      startUrl,
      startStatus: navigation.status,
      checked: checks.length,
      broken: broken.length,
      redirects: redirects.length,
      missingImages: missingImages.length,
    };

    await ctx.artifacts.writeJson('audit.json', { summary, checks, missingImages });

    return summary;
  },
});
