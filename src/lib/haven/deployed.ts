import { db } from '../db';
import type { ProtectionState } from './engine';
import { sampleProjects, summarizeProject, type DeployedProject } from './portfolio';
// "Reset preview" clears a Dashboard 2 project's saved HAVEN workspace. Sample projects are kept.
export async function resetWorkspace(id: string) {
  if (!id.startsWith('d2-')) return false;
  await db.protectionWorkspace.deleteMany({ where: { id } });
  return true;
}

// Every project that has been deployed at least once, including ones paused for edits.
// Sample projects are inserted once and then keep their own persisted simulation state.
export async function listDeployed(): Promise<DeployedProject[]> {
  for (const sample of sampleProjects())
    await db.protectionWorkspace.upsert({
      where: { id: sample.facility.id },
      create: { id: sample.facility.id, snapshot: JSON.stringify(sample) },
      update: {}, // inserted once; afterwards each sample keeps its own persisted state
    });
  const rows = await db.protectionWorkspace.findMany({ select: { snapshot: true }, orderBy: { updatedAt: 'desc' } });
  return rows
    .map((row) => JSON.parse(row.snapshot) as ProtectionState)
    .filter((state) => state.deployed || state.deployedAt)
    .map(summarizeProject);
}
