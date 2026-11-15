import { Suspense } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';
import { SignUp } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '@/components/account/auth-shell';

const sans = Geist({ subsets: ['latin'], variable: '--ps-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--ps-mono' });

export const metadata = { title: 'Sign up · GeoStar' };

export default function SignUpPage() {
  return (
    <div className={`${sans.variable} ${mono.variable}`}>
      <AuthShell
        title="Find it. Design it. Protect it."
        lede="Create your GeoStar account to save sites, designs and decisions, and pick them up on any device."
      >
        <Suspense fallback={null}>
          <SignUp appearance={clerkAppearance} signInUrl="/sign-in" fallbackRedirectUrl="/studio" />
        </Suspense>
      </AuthShell>
    </div>
  );
}
