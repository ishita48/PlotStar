import Link from 'next/link';
import type { ReactNode } from 'react';
import { Star } from '@/components/brand';
import './auth.css';

// The frame around Clerk's sign-in and sign-up forms: the GeoStar story on the left (on a real Vexcel aerial when the
// data service is up), the form on the right. Stacks on phones.
export function AuthShell({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <main className="gs-auth">
      <section className="gs-auth-story" aria-label="GeoStar">
        <Link href="/" className="gs-auth-mark" aria-label="GeoStar home">
          <span className="gs-auth-mark-icon">
            <Star />
          </span>
          <span>
            Geo<b>Star</b>
          </span>
        </Link>
        <div className="gs-auth-copy">
          <p className="gs-auth-eyebrow">Site intelligence for AI infrastructure</p>
          <h1>{title}</h1>
          <p className="gs-auth-lede">{lede}</p>
          <ol className="gs-auth-steps">
            <li>
              <b>Find</b> a site that clears homes, flood, water and power, from real CoStar properties.
            </li>
            <li>
              <b>Design</b> it in 3D, measured against your brief and priorities.
            </li>
            <li>
              <b>Protect</b> it with HAVEN once people move in.
            </li>
          </ol>
        </div>
        <p className="gs-auth-foot">Your projects and decisions are saved to your account.</p>
      </section>
      <section className="gs-auth-form">{children}</section>
    </main>
  );
}

// Clerk's form, restyled with GeoStar's palette and type.
export const clerkAppearance = {
  variables: {
    colorPrimary: '#1f4a36',
    colorText: '#101411',
    colorTextSecondary: '#4b5a51',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorInputText: '#101411',
    borderRadius: '12px',
    fontFamily: 'var(--ps-sans, -apple-system), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  elements: {
    card: { boxShadow: '0 24px 60px -32px rgba(16, 20, 17, 0.35)', border: '1px solid #dde5d6' },
    formButtonPrimary: { borderRadius: '999px', backgroundColor: '#101411', fontWeight: 600 },
    footerActionLink: { color: '#1f4a36', fontWeight: 600 },
  },
} as const;
