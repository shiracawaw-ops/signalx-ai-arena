
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useUser } from '@/context/user-context';
import { SignalXWordmark } from '@/components/signalx-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, ArrowLeft, CheckCircle, KeyRound, Mail, ShieldAlert } from 'lucide-react';

export default function ForgotPasswordPage() {
  const { forgotPassword } = useUser();
  const [, navigate] = useLocation();
  const [email,   setEmail]   = useState('');
  const [code,    setCode]    = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setError(null);
    setLoading(true);
    await new Promise(r => setTimeout(r, 500));
    const { code: c, error: err } = forgotPassword(email);
    setLoading(false);
    if (err) { setError(err); return; }
    setCode(c);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="flex justify-center mb-8">
          <SignalXWordmark size="lg" />
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800/60 rounded-2xl p-7 shadow-2xl">
          <Link href="/login" className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-5">
            <ArrowLeft size={12} /> Back to sign in
          </Link>

          <h2 className="text-xl font-bold text-zinc-100 mb-1">Forgot password?</h2>
          <p className="text-xs text-zinc-500 mb-6">Enter your email and we'll give you a recovery code.</p>

          {code ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle size={15} className="text-emerald-400 flex-shrink-0" />
                  <p className="text-xs text-emerald-400 font-medium">Recovery code generated</p>
                </div>
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  In a live system this code would be emailed to you. Since this is a local app, your code is shown here:
                </p>
                <div className="flex items-center justify-center py-3 rounded-lg bg-zinc-900 border border-zinc-700">
                  <span className="font-mono text-2xl font-bold tracking-[0.3em] text-amber-400">
                    {code}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500">Code expires in 15 minutes. Do not share it.</p>
              </div>

              <Button
                onClick={() => navigate(`/reset-password?email=${encodeURIComponent(email)}`)}
                className="w-full h-9 text-sm"
              >
                Continue to reset password
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-zinc-400">Email address</Label>
                <div className="relative">
                  <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
                  <Input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handle()}
                    placeholder="your@email.com"
                    className="pl-8 h-9 text-sm bg-zinc-800/60 border-zinc-700"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600/10 border border-red-600/30 text-red-400 text-xs">
                  <AlertTriangle size={12} className="flex-shrink-0" />
                  {error}
                </div>
              )}

              <Button onClick={handle} disabled={loading} className="w-full h-9 text-sm">
                <KeyRound size={13} className="mr-2" />
                {loading ? 'Checking…' : 'Send recovery code'}
              </Button>
            </div>
          )}

          <div className="mt-5 text-center text-xs text-zinc-600">
            Remembered it?{' '}
            <Link href="/login" className="text-red-400 hover:text-red-300 transition-colors font-medium">
              Sign in
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
