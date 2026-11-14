import type { Metadata } from 'next';
import { Workspace } from '@/components/explore/workspace';
import './explore.css';
import './workspace.css';

export const metadata: Metadata = {
  title: 'Site selection · PlotStar',
  description: 'Find buildable data center sites on real CoStar properties.',
};

export default function ExplorePage() {
  return <Workspace />;
}
