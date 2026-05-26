#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program.name('trace').description('Trace asset pipeline CLI (Phase 0: no-op).');

program
  .command('asset')
  .description('Asset subcommands')
  .addCommand(
    new Command('ingest')
      .description('Ingest a source GLB into a zone or vehicle bundle. Phase 0: stub.')
      .argument('<source>', 'Path to source .glb')
      .option('--kind <kind>', 'zone | vehicle', 'zone')
      .option('--id <id>', 'Stable id, e.g. zone_suzuka_demo')
      .option('--version <ver>', 'Semver, e.g. 1.0.0', '0.1.0')
      .action((source: string, opts: { kind: string; id?: string; version: string }) => {
        const id = opts.id ?? `${opts.kind}_unnamed`;
        console.warn(`[trace] (stub) would ingest ${source}`);
        console.warn(`        kind=${opts.kind} id=${id} version=${opts.version}`);
        console.warn(`[trace] Phase 0: no-op. See blueprint §10 for pipeline stages.`);
      }),
  )
  .addCommand(
    new Command('telemetry-inspect')
      .description('Decode and pretty-print a telemetry blob. Phase 0: stub.')
      .argument('<blob>', 'Path to .trc1 telemetry blob')
      .action((blob: string) => {
        console.warn(`[trace] (stub) would inspect telemetry blob: ${blob}`);
        console.warn(`[trace] Phase 0: no-op. See blueprint §12.`);
      }),
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
