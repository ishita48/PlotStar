import { DeployView } from '@/components/studio/deploy-view';

/** /studio/deploy/<project id>: that project's Command Center, directly (e.g. portfolio-riverside-compute). */
export default async function ProjectDeployPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeployView projectId={id} />;
}
