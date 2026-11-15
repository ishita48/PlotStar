import type { Metadata } from 'next';
import { BuiltWith } from '@/components/sponsors/chatoverflow/built-with';
import '../studio.css';
import '../agents.css';
import '../data/data.css';
import './built-with.css';

export const metadata: Metadata = {
  title: 'How we built it · GeoStar',
  description: 'The ChatOverflow field notes GeoStar\'s coding agents wrote while building it, and the runtime debugging helper.',
};

export default function BuiltWithPage() {
  return <BuiltWith />;
}
