/**
 * The run report, in two forms.
 *
 * `report.json` is what a downstream system ingests; `report.md` is what a person
 * reads. Both are built from the same data by the same pure function, so they can
 * never disagree — a divergence between the human and machine views of a run is the
 * kind of defect nobody notices until it matters.
 *
 * Building the report takes no I/O and no database handle: it is given a summary and
 * returns strings. That is what makes report content testable without running a crawl.
 */

import type { Artifact, Run, RunEvent } from '../state/types.js';

export interface ReportInput {
  readonly run: Run;
  readonly jobName: string;
  readonly workflow: string;
  /** Page counts by status, e.g. `{ visited: 12, error: 1 }`. */
  readonly pageCounts: Readonly<Record<string, number>>;
  /** Frontier entry counts by state. */
  readonly frontierCounts: Readonly<Record<string, number>>;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly artifacts: readonly Artifact[];
  /** Events worth surfacing in the human report: errors and warnings. */
  readonly problems: readonly RunEvent[];
  /** Whatever the workflow returned. Included verbatim in the JSON report. */
  readonly result?: unknown;
  /** Budget limits in force, recorded so a truncated run explains itself (spec §10). */
  readonly budget?: Readonly<Record<string, unknown>> | null;
}

export interface Report {
  readonly markdown: string;
  readonly json: string;
}

function durationOf(run: Run): string {
  if (run.finishedAt === null) return 'in progress';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countsTable(counts: Readonly<Record<string, number>>, empty: string): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return `_${empty}_\n`;
  return [
    '| Statut | Nombre |',
    '| --- | ---: |',
    ...entries.map(([key, value]) => `| \`${key}\` | ${String(value)} |`),
    '',
  ].join('\n');
}

export function buildReport(input: ReportInput): Report {
  const { run } = input;

  const json = {
    run: {
      id: run.id,
      jobId: run.jobId,
      jobName: input.jobName,
      workflow: input.workflow,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      duration: durationOf(run),
      stopReason: run.stopReason,
      error: run.error,
    },
    budget: input.budget ?? null,
    counters: run.counters,
    pages: input.pageCounts,
    frontier: input.frontierCounts,
    events: input.eventCounts,
    artifacts: input.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      sourceUrl: artifact.sourceUrl,
      canonicalUrl: artifact.canonicalUrl,
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
    })),
    problems: input.problems.map((event) => ({
      at: event.at,
      type: event.type,
      level: event.level,
      url: event.url,
      message: event.message,
    })),
    result: input.result ?? null,
  };

  const lines: string[] = [
    `# Rapport de run — ${input.jobName}`,
    '',
    `- **Run** : \`${run.id}\``,
    `- **Workflow** : \`${input.workflow}\``,
    `- **Statut** : \`${run.status}\`${run.stopReason === null ? '' : ` (${run.stopReason})`}`,
    `- **Déclenchement** : ${run.trigger}`,
    `- **Début** : ${run.startedAt}`,
    `- **Fin** : ${run.finishedAt ?? '—'}`,
    `- **Durée** : ${durationOf(run)}`,
    '',
    '## Compteurs',
    '',
    '| Mesure | Valeur |',
    '| --- | ---: |',
    `| Pages visitées | ${String(run.counters.pagesVisited)} |`,
    `| Pages découvertes | ${String(run.counters.pagesDiscovered)} |`,
    `| Artifacts créés | ${String(run.counters.artifactsCreated)} |`,
    `| Octets téléchargés | ${formatBytes(run.counters.downloadedBytes)} |`,
    `| Appels LLM | ${String(run.counters.llmCalls)} |`,
    `| Erreurs | ${String(run.counters.errorCount)} |`,
    '',
  ];

  if (input.budget !== null && input.budget !== undefined) {
    // Recording the limits in force is what lets a truncated run explain itself.
    lines.push('## Budget', '', '| Limite | Valeur |', '| --- | ---: |');
    for (const [key, value] of Object.entries(input.budget).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`| \`${key}\` | ${String(value)} |`);
    }
    lines.push('');
  }

  lines.push('## Pages', '', countsTable(input.pageCounts, 'Aucune page enregistrée.'));
  lines.push('## Frontier', '', countsTable(input.frontierCounts, 'Frontier vide.'));

  lines.push('## Artifacts', '');
  if (input.artifacts.length === 0) {
    lines.push('_Aucun artifact produit._', '');
  } else {
    lines.push('| Type | Chemin | Taille | Source |', '| --- | --- | ---: | --- |');
    for (const artifact of input.artifacts) {
      lines.push(
        `| \`${artifact.kind}\` | \`${artifact.path}\` | ` +
          `${artifact.bytes === null ? '—' : formatBytes(artifact.bytes)} | ` +
          `${artifact.sourceUrl ?? '—'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Problèmes', '');
  if (input.problems.length === 0) {
    lines.push('_Aucun._', '');
  } else {
    lines.push('| Niveau | Type | URL | Détail |', '| --- | --- | --- | --- |');
    for (const problem of input.problems) {
      lines.push(
        `| ${problem.level} | \`${problem.type}\` | ${problem.url ?? '—'} | ${problem.message ?? '—'} |`,
      );
    }
    lines.push('');
  }

  if (run.error !== null) {
    lines.push('## Erreur fatale', '', '```', run.error, '```', '');
  }

  return {
    markdown: `${lines.join('\n').trimEnd()}\n`,
    json: `${JSON.stringify(json, null, 2)}\n`,
  };
}
