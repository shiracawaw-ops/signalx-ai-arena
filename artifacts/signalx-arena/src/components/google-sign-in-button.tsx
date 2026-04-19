
import { useGoogleLogin } from '@react-oauth/google';
import { useState } from 'react';
import { useUser } from '@/context/user-context';
import { useLocation } from 'wouter';
import { Loader2 } from 'lucide-react';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

interface Props {
  label?: string;
}

export function GoogleSignInButton({ label = 'Continue with Google' }: Props) {
  const { googleLogin } = useUser();
  const [, navigate] = useLocation();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        setLoading(true);
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        if (!res.ok) throw new Error('Failed to fetch Google user info');
        const gUser = await res.json();
        const { error: err } = googleLogin({
          googleId: gUser.sub,
          email:    gUser.email,
          name:     gUser.name,
          avatar:   gUser.picture,
        });
        if (err) { setError(err); setLoading(false); return; }
        navigate('/');
      } catch {
        setError('Google sign-in failed. Please try again.');
        setLoading(false);
      }
    },
    onError: () => {
      setError('Google sign-in was cancelled or failed.');
      setLoading(false);
    },
  });

  if (!GOOGLE_CLIENT_ID) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => { setError(null); setLoading(true); login(); }}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2.5 h-9 rounded-lg border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-700/60 transition-colors text-sm text-zinc-200 font-medium disabled:opacity-60"
      >
        {loading ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
        )}
        {loading ? 'Connecting…' : label}
      </button>
      {error && (
        <p className="text-[11px] text-red-400 text-center">{error}</p>
      )}
    </div>
  );
}

/** Returns true only when a Google Client ID is configured */
export function hasGoogleAuth(): boolean {
  return !!GOOGLE_CLIENT_ID;
}
