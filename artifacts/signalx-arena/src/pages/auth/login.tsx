
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useUser } from '@/context/user-context';
import { SignalXWordmark } from '@/components/signalx-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GoogleSignInButton, hasGoogleAuth } from '@/components/google-sign-in-button';
import { AlertTriangle, Eye, EyeOff, Lock, Mail, ShieldAlert } from 'lucide-react';

export default function LoginPage() {
  const { login } = useUser();
  const [, navigate]  = useLocation();
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);

  const handle = async () => {
    setError(null);
    setLoading(true);
    await new Promise(r => setTimeout(r, 300));
    const { error: err } = login(email, password);
    setLoading(false);
    if (err) { setError(err); return; }
    navigate('/');
  };

  const fillDemo = (type: 'demo' | 'admin') => {
    setEmail(type === 'demo' ? 'demo@signalx.ai' : 'admin@signalx.ai');
    setPassword(type === 'demo' ? 'demo123' : 'admin123');
    setError(null);
  };

  const showGoogle = hasGoogleAuth();

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex justify-center mb-8">
          <SignalXWordmark size="lg" />
        </div>

        {/* Card */}
        <div className="bg-zinc-900/80 border border-zinc-800/60 rounded-2xl p-7 shadow-2xl">
          <h2 className="text-xl font-bold text-zinc-100 mb-1">Sign in</h2>
          <p className="text-xs text-zinc-500 mb-6">Paper trading — no real money involved</p>

          {/* Demo credentials */}
          <div className="mb-5 p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/60 space-y-2">
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold mb-1">Quick access</p>
            <div className="flex gap-2">
              <button onClick={() => fillDemo('demo')}
                className="flex-1 text-xs py-1.5 rounded-lg bg-blue-600/15 border border-blue-600/30 text-blue-400 hover:bg-blue-600/25 transition-colors font-medium">
                Demo Trader
              </button>
              <button onClick={() => fillDemo('admin')}
                className="flex-1 text-xs py-1.5 rounded-lg bg-red-600/15 border border-red-600/30 text-red-400 hover:bg-red-600/25 transition-colors font-medium">
                Admin
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Email</Label>
              <div className="relative">
                <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <Input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handle()}
                  placeholder="your@email.com" className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-zinc-400">Password</Label>
                <Link href="/forgot-password" className="text-[11px] text-zinc-500 hover:text-red-400 transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <Input
                  type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handle()}
                  placeholder="••••••" className="pl-8 pr-9 h-9 text-sm bg-zinc-800/60 border-zinc-700"
                />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400">
                  {showPass ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600/10 border border-red-600/30 text-red-400 text-xs">
                <AlertTriangle size={12} className="flex-shrink-0" />
                {error}
              </div>
            )}

            <Button onClick={handle} disabled={loading} className="w-full h-9 text-sm">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>

            {showGoogle && (
              <>
                <div className="relative flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span className="text-[10px] text-zinc-600 uppercase tracking-widest">or</span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>
                <GoogleSignInButton label="Sign in with Google" />
              </>
            )}
          </div>

          <div className="mt-5 text-center text-xs text-zinc-600">
            No account?{' '}
            <Link href="/signup" className="text-red-400 hover:text-red-300 transition-colors font-medium">
              Create one free
            </Link>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="mt-6 px-4 py-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
          <div className="flex items-start gap-2">
            <ShieldAlert size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              <strong className="text-zinc-500">Risk Disclaimer:</strong> SignalX is a paper trading simulator.
              All trades use virtual funds. Past simulation results do not guarantee future performance.
              No real money is involved. Do not treat this as financial advice.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
