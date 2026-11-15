'use client';
// Sign in / sign up for signed-out visitors, the Clerk user menu for signed-in ones. Renders nothing when Clerk is not
// configured, so the app works the same without keys. Signing in also saves the user to MongoDB Atlas, once per session.
import Link from 'next/link';
import { useEffect } from 'react';
import { Show, UserButton, useAuth } from '@clerk/nextjs';

const ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

function SaveToAtlas() {
  const { isSignedIn, userId, getToken } = useAuth();
  useEffect(() => {
    if (!isSignedIn || !userId) return;
    const key = `geostar.account.synced.${userId}`;
    try {
      if (sessionStorage.getItem(key)) return;
    } catch {
      /* storage blocked: sync anyway */
    }
    (async () => {
      const token = await getToken();
      const res = await fetch('/api/account/sync', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        try {
          sessionStorage.setItem(key, '1');
        } catch {
          /* fine */
        }
      }
    })().catch(() => {});
  }, [isSignedIn, userId, getToken]);
  return null;
}

export function AccountControls({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  if (!ENABLED) return null;
  return (
    <span className={`gs-account gs-account-${tone}`}>
      <Show when="signed-out">
        <Link href="/sign-in" className="gs-account-link">
          Sign in
        </Link>
        <Link href="/sign-up" className="gs-account-cta">
          Sign up
        </Link>
      </Show>
      <Show when="signed-in">
        <SaveToAtlas />
        <UserButton appearance={{ elements: { avatarBox: { width: 30, height: 30 } } }} />
      </Show>
    </span>
  );
}
