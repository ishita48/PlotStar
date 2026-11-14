import type { Metadata } from 'next';
import { Studio } from '@/components/studio/studio';
import '../explore/explore.css';
import '../explore/workspace.css';
import './studio.css';
import './studio-polish.css';
import './discover.css';
import './analyze.css';
// Design step: the Smart Blocks facility twin keeps its own (scoped) styles
import '../dashboard-2/dashboard.css';
import '../dashboard-2/protection.css';
import '../dashboard-2/smart-blocks.css';
import '../dashboard-2/command.css';
import './design.css';
import './design-theme.css';

export const metadata: Metadata = {
  title: 'Studio · GeoStar',
  description: 'From a data center brief to three measured layouts on a real site.',
};

export default function StudioPage() {
  return <Studio />;
}
