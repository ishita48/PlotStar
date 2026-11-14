import type { Metadata } from 'next';
import { PlotStarScreen } from '@/components/explore/plotstar-screen';
import './explore.css';

export const metadata: Metadata = {
  title: 'Explore · PlotStar',
  description: 'Find buildable data center sites on real CoStar properties.',
};

export default function ExplorePage() {
  return <PlotStarScreen />;
}
