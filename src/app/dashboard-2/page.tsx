import type { Metadata } from 'next';
import { DashboardTwo } from '@/components/dashboard-2/dashboard';
import './dashboard.css';
import './protection.css';

export const metadata: Metadata = {
  title: 'AFTERLIGHT · Dashboard 2',
  description: 'An interface preview of the AFTERLIGHT planning workspace.',
};

export default function DashboardTwoPage() {
  return <DashboardTwo />;
}
