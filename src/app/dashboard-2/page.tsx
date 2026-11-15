import type { Metadata } from 'next';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import { DashboardTwo } from '@/components/dashboard-2/dashboard';
import './dashboard.css';
import './protection.css';
import './smart-blocks.css';
import './command.css';
import './geostar.css';

// Same type as the landing page, so moving from the story into the workspace feels like one product.
const sans = Geist({ subsets: ['latin'], variable: '--ps-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--ps-mono' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--ps-serif' });

export const metadata: Metadata = {
  title: 'GeoStar · Workspace',
  description: 'GeoStar: locate, design, protect and deploy a site in one connected workspace.',
};

export default function DashboardTwoPage() {
  return (
    <div className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <DashboardTwo />
    </div>
  );
}
