import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';
import '@/components/account/auth.css';

export const metadata: Metadata = {
  title: 'GeoStar — Find it. Design it. Protect it.',
  description:
    'From the right place to a better-built future. Site intelligence, conceptual architecture, and connected building protection.',
};

// Clerk (sign-in / sign-up) wraps the app only when its keys are configured; without them everything else still works.
const CLERK = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{CLERK ? <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">{children}</ClerkProvider> : children}</body>
    </html>
  );
}
