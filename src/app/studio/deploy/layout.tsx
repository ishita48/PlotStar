import type { Metadata } from 'next';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
// Same styles as Studio's Deploy step, so a Command Center looks identical here.
import '../../explore/explore.css';
import '../../explore/workspace.css';
import '../studio.css';
import '../studio-polish.css';
import '../../dashboard-2/dashboard.css';
import '../../dashboard-2/protection.css';
import '../../dashboard-2/smart-blocks.css';
import '../../dashboard-2/command.css';
import '../../dashboard-2/geostar.css';
import '../design.css';
import '../design-theme.css';
import '../geostar.css';
import '../shell.css';
import './deploy.css';

const sans = Geist({ subsets: ['latin'], variable: '--ps-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--ps-mono' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--ps-serif' });

export const metadata: Metadata = {
  title: 'Deploy · GeoStar',
  description: 'Every deployed project and its Command Center, with live hardware.',
};

export default function DeployLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${sans.variable} ${mono.variable} ${serif.variable}`}>{children}</div>;
}
