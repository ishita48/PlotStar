import { Suspense } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';
import { SignIn } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '@/components/account/auth-shell';

const sans = Geist({ subsets: ['latin'], variable: '--ps-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--ps-mono' });

export const metadata = { title: 'Sign in · GeoStar' };

export default function SignInPage() {
  return (
    <div className={`${sans.variable} ${mono.variable}`}>
      <AuthShell title="Welcome back." lede="Pick up where you left off: your sites, your designs and your decisions.">
        <Suspense fallback={null}>
          <SignIn appearance={clerkAppearance} signUpUrl="/sign-up" fallbackRedirectUrl="/studio" />
        </Suspense>
      </AuthShell>
    </div>
  );
}
