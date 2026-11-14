import { db } from './db';
import { makeSites, parseBrief, weightDefaults } from './engine';
import { interpretBrief } from './llm';
import type { Project } from './types';
export const includeProject = {
  sensors: { orderBy: { name: 'asc' as const } },
  incidents: { orderBy: { createdAt: 'desc' as const } },
  messages: { orderBy: { createdAt: 'asc' as const } },
  simulations: { orderBy: { createdAt: 'desc' as const } },
};
export function decodeProject(raw: unknown): Project {
  const p = JSON.parse(JSON.stringify(raw));
  return {
    ...p,
    requirements: JSON.parse(p.requirements),
    sites: JSON.parse(p.sites),
    designs: JSON.parse(p.designs),
    weights: JSON.parse(p.weights),
  };
}
export async function getProject(id: string) {
  const raw = await db.project.findUnique({ where: { id }, include: includeProject });
  return raw ? decodeProject(raw) : null;
}
export async function createProject(brief: string) {
  const p = await interpretBrief(brief);
  return decodeProject(
    await db.project.create({
      data: {
        ...p,
        brief,
        requirements: JSON.stringify(p.requirements),
        sites: JSON.stringify(makeSites(p.type, p.requirements.location)),
        weights: JSON.stringify(weightDefaults[p.type]),
      },
      include: includeProject,
    }),
  );
}
export const demos = [
  'Find a student dormitory near Princeton, with 200 beds, good walkability and strong investment returns. Budget $28 million.',
  'Find a suitable location for a 100 MW data center near Princeton with electrical infrastructure and minimal environmental conflicts. Budget $900 million.',
  'Create a community park near Princeton for 500 visitors, prioritizing underserved neighborhoods, schools and green space. Budget $8 million.',
];
export async function ensureDemos() {
  for (let i = 0; i < demos.length; i++) {
    const p = parseBrief(demos[i]);
    await db.project.upsert({
      where: { id: `demo-${i + 1}` },
      update: {},
      create: {
        id: `demo-${i + 1}`,
        name: p.name,
        brief: demos[i],
        type: p.type,
        requirements: JSON.stringify(p.requirements),
        sites: JSON.stringify(makeSites(p.type)),
        weights: JSON.stringify(weightDefaults[p.type]),
      },
    });
  }
}
