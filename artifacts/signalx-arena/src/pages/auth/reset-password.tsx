
import { useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useUser } from '@/context/user-context';
import { SignalXWordmark } from '@/components/signalx-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, ArrowLeft, CheckCircle, Eye, EyeOff, KeyRound, Lock, Mail, ShieldAlert } from 'lucide-react';

export default function ResetPasswordPage() {
  const { doResetPassword } = useUser();
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const prefillEmail = params.get('email') ?? '';

  const [email,    setEmail]    = useState(prefillEmail);
  const [code,     setCode]     = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);

  const handle = async () => {
    setError(null);
    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    const { error: err } = doResetPassword(email, code, password);
    setLoading(false);
    if (err) { setError(err); return; }
    setDone(true);
    setTimeout(() => navigate('/'), 2000);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="flex justify-center mb-8">
          <SignalXWordmark size="lg" />
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/60 rounded-2xl p-7 shadow-2xl">
          <Link href="/forgot-password" className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-5">
            <ArrowLeft size={12} /> Back
          </Link>

          <h2 className="text-xl font-bold text-zinc-100 mb-1">Reset password</h2>
          <p className="text-xs text-zinc-500 mb-6">Enter your recovery code and choose a new password.</p>

          {done ? (
            <div className="py-6 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <CheckCircle size={22} className="text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-zinc-200">Password reset successfully!</p>
              <p className="text-xs text-zinc-500">Signing you in…</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">Email address</Label>
                <div className="relative">
                  <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <Input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">Recovery code</Label>
                <div className="relative">
                  <KeyRound size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <Input
                    type="text" value={code} onChange={e => setCode(e.target.value)}
                    placeholder="6-digit code"
                    maxLength={6}
                    className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700 font-mono tracking-widest"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">New password</Label>
                <div className="relative">
                  <Lock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <Input
                    type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handle()}
                    placeholder="Min. 6 characters"
                    className="pl-8 pr-9 h-9 text-sm bg-zinc-800/60 border-zinc-700"
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
                {loading ? 'Resetting…' : 'Reset password'}
              </Button>
            </div>
          )}

          <div className="mt-5 text-center text-xs text-zinc-600">
            Need a new code?{' '}
            <Link href="/forgot-password" className="text-red-400 hover:text-red-300 transition-colors font-medium">
              Request again
            </Link>
          </div>
        </div>

        <div className="mt-6 px-4 py-3 rounded-xl border border-zinc-800/60 bg-zinc-900/30">
          <div className="flex items-start gap-2">
            <ShieldAlert size={13} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              <strong className="text-zinc-500">Risk Disclaimer:</strong> SignalX is a paper trading simulator.
              All trades use virtual funds. No real money is involved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
