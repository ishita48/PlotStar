import type { Metadata } from 'next';
import { ExploreApp } from '@/components/explore/explore-app';
import './explore.css';

export const metadata: Metadata = {
  title: 'Explore · PlotStar',
  description: 'Find buildable data center sites on real CoStar properties.',
};

export default function ExplorePage() {
  return <ExploreApp />;
}
