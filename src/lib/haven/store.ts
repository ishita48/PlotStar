import { db } from '../db';
import {
  initialProtectionState,
  transitionProtection,
  type Facility,
  type ProtectionAction,
  type ProtectionState,
} from './engine';

// One row per facility in the ProtectionWorkspace model: the facility's whole HAVEN state as JSON. Plain Prisma calls,
// so the same code runs on SQLite (local) and Postgres (Neon, on Vercel).
export async function loadProtection(facility: Facility): Promise<ProtectionState> {
  const row = await db.protectionWorkspace.findUnique({ where: { id: facility.id }, select: { snapshot: true } });
  return row ? JSON.parse(row.snapshot) : initialProtectionState(facility);
}
export async function changeProtection(
  facility: Facility,
  revision: number,
  command: ProtectionAction,
) {
  return db.$transaction(async (tx) => {
    const row = await tx.protectionWorkspace.findUnique({ where: { id: facility.id }, select: { snapshot: true } });
    const previous: ProtectionState = row ? JSON.parse(row.snapshot) : initialProtectionState(facility);
    if (previous.revision !== revision)
      throw new Error(
        'This facility changed in another window. Reload its latest state before retrying.',
      );
    const next = transitionProtection(previous, command);
    const snapshot = JSON.stringify(next);
    await tx.protectionWorkspace.upsert({
      where: { id: facility.id },
      create: { id: facility.id, snapshot },
      update: { snapshot },
    });
    return next;
  });
}
