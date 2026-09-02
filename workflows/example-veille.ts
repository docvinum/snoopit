/**
 * Workflow `audit` : veille — signaler ce qui a changé depuis la dernière visite.
 *
 * Écrit en ne consultant que `skills/snoopit/SKILL.md`, comme le ferait un coding
 * agent : c'est l'épreuve du critère du Lot 6.
 *
 * Cas d'usage de référence « veille de sites sources » (docs/USE_CASES.md §1) :
 * visiter régulièrement des pages connues, détecter les nouveautés et les
 * modifications, produire un rapport lisible.
 */

import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'example-veille',
  type: 'audit',
  description: 'Visite des pages suivies et signale celles qui ont changé',
  budget: { maxPages: 30, maxDuration: '10m', maxLlmCalls: 0 },

  async run(ctx) {
    const startUrl = process.env['SNOOPIT_VEILLE_URL'] ?? 'http://127.0.0.1:8080/index.html';
    // Cadence de revisite. Une page vérifiée n'est reprise qu'à son échéance : c'est
    // ce qui empêche une veille quotidienne de retélécharger tout le site chaque jour.
    const revisitAfter = process.env['SNOOPIT_VEILLE_REVISIT'] ?? '1d';

    // Les pages dont l'échéance de revisite est passée retournent en file.
    // À faire au début : une visite rafraîchit next_visit_after.
    const requeued = ctx.frontier.enqueueDueRevisits();

    // Point d'entrée : on le visite et on en découvre les pages à suivre.
    const { page, changed: indexChanged } = await ctx.visit(startUrl, {
      waitFor: '.publication-list',
      revisitAfter,
    });
    await ctx.dismissOverlays(page);

    const links = await ctx.extract(page, {
      selector: '.publication .title',
      fields: { url: '@href', titre: '@text' },
    });
    for (const link of links) {
      if (link.url !== null) ctx.frontier.discover(link.url);
    }
    await page.close();

    // Visite de chaque page suivie ; on relève celles qui ont bougé.
    const nouvelles: string[] = [];
    const modifiees: string[] = [];
    const erreurs: { url: string; status: number | null }[] = [];
    // Compté séparément : « 0 modifiée sur 0 vérifiée » et « 0 modifiée sur 12
    // vérifiées » sont deux constats opposés, et les confondre rend la veille
    // inutile — elle rapporterait « rien n'a bougé » sans avoir rien regardé.
    let verifiees = 0;

    for (const entry of ctx.frontier.take(30)) {
      const visit = await ctx.visit(entry.url, { revisitAfter });
      verifiees += 1;
      try {
        if (!visit.navigation.ok) {
          erreurs.push({ url: entry.url, status: visit.navigation.status });
        } else if (visit.firstVisit) {
          nouvelles.push(entry.url);
        } else if (visit.changed) {
          modifiees.push(entry.url);
        }
        ctx.frontier.complete(entry);
      } finally {
        await visit.page.close();
      }
    }

    const resume = {
      startUrl,
      indexChanged,
      requeued,
      suivies: links.length,
      verifiees,
      nouvelles: nouvelles.length,
      modifiees: modifiees.length,
      erreurs: erreurs.length,
    };

    const rapport = [
      `# Veille — ${new Date().toISOString()}`,
      '',
      `Point d'entrée : ${startUrl}${indexChanged ? ' (modifié)' : ''}`,
      `Pages vérifiées ce run : ${String(verifiees)} (les autres ne sont pas encore dues)`,
      '',
      `## Nouvelles pages (${String(nouvelles.length)})`,
      ...(nouvelles.length === 0 ? ['_Aucune._'] : nouvelles.map((u) => `- ${u}`)),
      '',
      `## Pages modifiées (${String(modifiees.length)})`,
      ...(modifiees.length === 0 ? ['_Aucune._'] : modifiees.map((u) => `- ${u}`)),
      '',
      `## Erreurs (${String(erreurs.length)})`,
      ...(erreurs.length === 0
        ? ['_Aucune._']
        : erreurs.map((e) => `- ${e.url} — HTTP ${String(e.status ?? 0)}`)),
      '',
    ].join('\n');

    await ctx.artifacts.writeMarkdown('veille.md', rapport);
    await ctx.artifacts.writeJson('veille.json', { resume, nouvelles, modifiees, erreurs });

    return resume;
  },
});
