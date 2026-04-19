
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useUser } from '@/context/user-context';
import { SignalXWordmark } from '@/components/signalx-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GoogleSignInButton, hasGoogleAuth } from '@/components/google-sign-in-button';
import { AlertTriangle, Check, Eye, EyeOff, Lock, Mail, ShieldAlert, User } from 'lucide-react';

const PLAN_FEATURES = [
  'Full AutoPilot decision engine',
  'Paper trading with fees & slippage',
  'Bot performance reports',
  'Risk engine & alerts',
  'API connection ready (Binance)',
];

export default function SignupPage() {
  const { signup } = useUser();
  const [, navigate] = useLocation();
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);

  const handle = async () => {
    setError(null);
    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    const { error: err } = signup(email, name, password);
    setLoading(false);
    if (err) { setError(err); return; }
    navigate('/');
  };

  const showGoogle = hasGoogleAuth();

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="flex justify-center mb-8">
          <SignalXWordmark size="lg" />
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/60 rounded-2xl p-7 shadow-2xl">
          <h2 className="text-xl font-bold text-zinc-100 mb-1">Create account</h2>
          <p className="text-xs text-zinc-500 mb-5">Free forever · Paper trading · No credit card</p>

          {/* What you get */}
          <div className="mb-5 p-3 rounded-xl bg-zinc-800/40 border border-zinc-800 space-y-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">Free plan includes</p>
            {PLAN_FEATURES.map(f => (
              <div key={f} className="flex items-center gap-2">
                <Check size={10} className="text-emerald-400 flex-shrink-0" />
                <span className="text-[11px] text-zinc-400">{f}</span>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Full name</Label>
              <div className="relative">
                <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <Input value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your name" className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Email</Label>
              <div className="relative">
                <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <Input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com" className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-zinc-400">Password</Label>
              <div className="relative">
                <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                <Input type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handle()}
                  placeholder="Min. 6 characters" className="pl-8 pr-9 h-9 text-sm bg-zinc-800/60 border-zinc-700" />
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
              {loading ? 'Creating account…' : 'Create free account'}
            </Button>

            {showGoogle && (
              <>
                <div className="relative flex items-center gap-3 my-1">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span className="text-[10px] text-zinc-600 uppercase tracking-widest">or</span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>
                <GoogleSignInButton label="Sign up with Google" />
              </>
            )}
          </div>

          <div className="mt-5 text-center text-xs text-zinc-600">
            Already have an account?{' '}
            <Link href="/login" className="text-red-400 hover:text-red-300 transition-colors font-medium">
              Sign in
            </Link>
          </div>
        </div>

        <div className="mt-6 px-4 py-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
          <div className="flex items-start gap-2">
            <ShieldAlert size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              <strong className="text-zinc-500">Paper trading only.</strong> All funds are virtual.
              SignalX does not manage real money. Results are simulated and do not reflect real market performance.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
