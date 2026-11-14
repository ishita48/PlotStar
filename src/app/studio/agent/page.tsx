import type { Metadata } from 'next';
import { AgentView } from '@/components/studio/agent-view';
import '../studio.css';
import './agent.css';

export const metadata: Metadata = {
  title: 'Agent · GeoStar',
  description: 'How GeoStar\'s AI works: a live LangGraph pipeline with LangSmith tracing.',
};

export default function AgentPage() {
  return <AgentView />;
}
