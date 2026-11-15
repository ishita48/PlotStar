'use client';
// Direct entry to Deploy without walking the Studio flow: /studio/deploy lists every deployed
// project, /studio/deploy/<id> opens that project's Command Center (live hardware included).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, LayoutGrid } from 'lucide-react';
import type { Facility } from '@/lib/haven/engine';
import type { DeployedProject } from '@/lib/haven/portfolio';
import { DeployedProjects, ProjectCommandCenter } from '../dashboard-2/deployed-projects';

function useProject(id?: string) {
  const [facility, setFacility] = useState<Facility | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let active = true;
    setFacility(null);
    setError('');
    fetch('/api/protection', { cache: 'no-store' })
      .then(async (r) => {
        const data = (await r.json()) as { projects?: DeployedProject[]; error?: string };
        if (!r.ok) throw new Error(data.error || 'Cannot load deployed projects.');
        const match = data.projects?.find((p) => p.facility.id === id);
        if (!active) return;
        if (match) setFacility(match.facility);
        else setError(`No deployed project has the id “${id}”.`);
      })
      .catch((e) => active && setError((e as Error).message));
    return () => {
      active = false;
    };
  }, [id]);
  return { facility, error };
}

export function DeployView({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const { facility, error } = useProject(projectId);

  return (
    <div className="st st-deploy">
      <header className="st-top">
        <Link href="/" className="brand" aria-label="GeoStar home">
          <span>
            Geo<b>Star</b>
          </span>
        </Link>
        <div className="st-top-title">
          <b>Deploy</b>
          <span>{projectId ? (facility?.name ?? 'Command Center') : 'Every deployed project'}</span>
        </div>
        <nav className="st-top-nav" aria-label="Deploy">
          {projectId && (
            <Link href="/studio/deploy">
              <LayoutGrid size={12} /> All projects
            </Link>
          )}
          <Link href="/studio">
            <ArrowLeft size={12} /> Studio
          </Link>
        </nav>
      </header>
      <main className="st-deploy-main">
        <div className="d2-shell sb st-twin-host st-sb-host">
          {!projectId ? (
            <DeployedProjects onOpen={(f) => router.push(`/studio/deploy/${f.id}`)} />
          ) : facility ? (
            <ProjectCommandCenter
              key={facility.id}
              facility={facility}
              onBack={() => router.push('/studio/deploy')}
            />
          ) : error ? (
            <div className="hv-save-error" role="alert">
              <span>{error}</span>
              <button onClick={() => router.push('/studio/deploy')}>See all projects</button>
            </div>
          ) : (
            <div className="st-model-loading">Loading the Command Center…</div>
          )}
        </div>
      </main>
    </div>
  );
}
