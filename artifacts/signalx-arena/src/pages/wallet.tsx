
import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useArena } from '@/hooks/use-arena';
import { getBotTotalValue, getBotPnL } from '@/lib/engine';
import { loadWallet, saveWallet, requestDeposit, requestWithdrawal, type WalletState, type Transaction } from '@/lib/wallet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import {
  Wallet, ArrowDownCircle, ArrowUpCircle, Clock, CheckCircle2,
  XCircle, RefreshCw, TrendingUp, DollarSign, AlertTriangle, FileText, Bot,
} from 'lucide-react';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtBalance(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n}`;
}

const TX_ICONS: Record<string, React.ElementType> = {
  deposit:    ArrowDownCircle,
  withdrawal: ArrowUpCircle,
  trade_fee:  DollarSign,
  profit:     TrendingUp,
  loss:       TrendingUp,
  transfer:   RefreshCw,
};
const TX_COLORS: Record<string, string> = {
  deposit:    'text-emerald-400',
  withdrawal: 'text-amber-400',
  trade_fee:  'text-zinc-400',
  profit:     'text-emerald-400',
  loss:       'text-red-400',
  transfer:   'text-blue-400',
};
const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  pending:   'bg-amber-500/10 text-amber-400 border-amber-500/30',
  failed:    'bg-red-500/10 text-red-400 border-red-500/30',
  cancelled: 'bg-zinc-700/30 text-zinc-400 border-zinc-600/30',
};

export default function WalletPage() {
  const { bots, demoBalance, botCount, getCurrentPrice, resetAll } = useArena();
  const [wallet, setWallet] = useState<WalletState>(() => loadWallet());
  const [tab, setTab] = useState<'overview' | 'arena' | 'deposit' | 'withdraw' | 'history'>('overview');
  const [depositAmt, setDepositAmt] = useState('1000');
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const { toast } = useToast();

  // Arena stats derived from shared context
  const totalValue   = useMemo(() => bots.reduce((s, b) => s + getBotTotalValue(b, getCurrentPrice(b.symbol)), 0), [bots, getCurrentPrice]);
  const totalPnl     = useMemo(() => bots.reduce((s, b) => s + getBotPnL(b, getCurrentPrice(b.symbol)), 0), [bots, getCurrentPrice]);
  const totalBalance = useMemo(() => bots.reduce((s, b) => s + b.balance, 0), [bots]);
  const allocatedCapital = useMemo(() => bots.reduce((s, b) => s + (b.position > 0 ? b.position * (b.avgEntryPrice || 0) : 0), 0), [bots]);
  const initialCapital   = botCount * demoBalance;

  const handleDeposit = () => {
    const amt = parseFloat(depositAmt);
    if (!amt || amt <= 0) { toast({ title: 'Invalid amount', variant: 'destructive' }); return; }
    const updated = requestDeposit(wallet, amt);
    setWallet(updated);
    toast({ title: `Deposited $${fmt(amt)}`, description: 'Virtual funds added to your account.' });
    setDepositAmt('');
  };

  const handleWithdraw = () => {
    const amt = parseFloat(withdrawAmt);
    if (!amt || amt <= 0) { toast({ title: 'Invalid amount', variant: 'destructive' }); return; }
    const { wallet: updated, error } = requestWithdrawal(wallet, amt);
    if (error) { toast({ title: 'Withdrawal failed', description: error, variant: 'destructive' }); return; }
    setWallet(updated);
    toast({ title: `Withdrawal of $${fmt(amt)} submitted`, description: 'Pending admin approval (demo mode).' });
    setWithdrawAmt('');
  };

  const recentTxs = [...wallet.transactions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);

  const TABS = [
    { key: 'overview', label: 'Overview',     icon: Wallet          },
    { key: 'arena',    label: 'Arena Funds',  icon: Bot             },
    { key: 'deposit',  label: 'Deposit',      icon: ArrowDownCircle },
    { key: 'withdraw', label: 'Withdraw',     icon: ArrowUpCircle   },
    { key: 'history',  label: 'History',      icon: FileText        },
  ] as const;

  return (
    <div className="p-4 max-w-screen-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-emerald-600/10 border border-emerald-600/30 flex items-center justify-center">
          <Wallet size={18} className="text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-bold">Wallet</h1>
          <p className="text-xs text-zinc-500">Virtual balance · Arena capital · Transaction ledger</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-zinc-800/60 pb-3 overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors font-medium whitespace-nowrap
                ${tab === t.key ? 'bg-emerald-600/15 border border-emerald-600/30 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'}`}>
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-900/10 to-transparent">
            <CardContent className="p-5">
              <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Available Balance</div>
              <div className="text-4xl font-black font-mono text-emerald-400 mb-3">
                ${fmt(wallet.virtualBalance - wallet.lockedBalance)}
              </div>
              {wallet.lockedBalance > 0 && (
                <div className="text-xs text-amber-400 mb-2">Locked: ${fmt(wallet.lockedBalance)} (pending withdrawal)</div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-zinc-800/60">
                {[
                  { label: 'Total Deposited', value: `$${fmt(wallet.totalDeposited)}` },
                  { label: 'Total Withdrawn', value: `$${fmt(wallet.totalWithdrawn)}`  },
                  { label: 'Fees Paid',       value: `$${fmt(wallet.totalFeesPaid)}`   },
                  { label: 'Net P&L',         value: `${wallet.totalPnl >= 0 ? '+' : ''}$${fmt(wallet.totalPnl)}` },
                ].map(s => (
                  <div key={s.label}>
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{s.label}</div>
                    <div className="font-mono font-semibold text-sm mt-0.5">{s.value}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Recent Activity</CardTitle></CardHeader>
            <CardContent className="p-0">
              {recentTxs.length === 0 ? (
                <div className="py-12 text-center text-zinc-600 text-sm">No transactions yet</div>
              ) : recentTxs.slice(0, 8).map(tx => {
                const Icon = TX_ICONS[tx.type] || DollarSign;
                const color = TX_COLORS[tx.type] || 'text-zinc-400';
                const isDebit = tx.type === 'loss' || tx.type === 'withdrawal' || tx.type === 'trade_fee';
                return (
                  <div key={tx.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/40 last:border-0">
                    <Icon size={14} className={color} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{tx.description}</div>
                      <div className="text-[10px] text-zinc-500">{new Date(tx.timestamp).toLocaleString()}</div>
                    </div>
                    <span className={`text-xs font-mono font-semibold ${isDebit ? 'text-red-400' : 'text-emerald-400'}`}>
                      {isDebit ? '-' : '+'}${fmt(tx.amount)}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${STATUS_BADGE[tx.status] ?? ''}`}>{tx.status}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Arena Funds ── */}
      {tab === 'arena' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Initial Capital', value: `$${fmt(initialCapital)}`,    color: 'text-blue-400',    sub: `${botCount} bots × ${fmtBalance(demoBalance)}` },
              { label: 'Current Value',   value: `$${fmt(totalValue)}`,         color: 'text-zinc-200',    sub: 'Cash + positions' },
              { label: 'Total P&L',       value: `${totalPnl >= 0 ? '+' : ''}$${fmt(totalPnl)}`, color: totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400', sub: `${((totalPnl / initialCapital) * 100).toFixed(2)}%` },
              { label: 'Allocated',       value: `$${fmt(allocatedCapital)}`,   color: 'text-amber-400',   sub: 'In open positions' },
            ].map(s => (
              <Card key={s.label} className="border-zinc-800/60 bg-zinc-900/40">
                <CardContent className="p-4">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">{s.label}</div>
                  <div className={`font-mono font-bold text-xl ${s.color}`}>{s.value}</div>
                  <div className="text-[10px] text-zinc-600 mt-0.5">{s.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm">Per-Bot Balance Distribution</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-zinc-900">
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      {['Bot', 'Balance', 'P&L', 'Position'].map(h => (
                        <th key={h} className="text-left px-2 py-2 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bots.slice(0, 100).map(b => {
                      const price = getCurrentPrice(b.symbol);
                      const pnl   = getBotPnL(b, price);
                      return (
                        <tr key={b.id} className="border-b border-zinc-800/30 hover:bg-zinc-900/50">
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: b.color }} />
                              <span className="truncate max-w-28">{b.name}</span>
                            </div>
                          </td>
                          <td className="px-2 py-1.5 font-mono">${fmt(b.balance)}</td>
                          <td className={`px-2 py-1.5 font-mono ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {pnl >= 0 ? '+' : ''}${fmt(pnl)}
                          </td>
                          <td className="px-2 py-1.5 text-zinc-400">{b.position > 0 ? `${b.position.toFixed(4)} ${b.symbol}` : '—'}</td>
                        </tr>
                      );
                    })}
                    {bots.length > 100 && (
                      <tr><td colSpan={4} className="px-2 py-2 text-center text-zinc-600">… {bots.length - 100} more bots</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => resetAll()}
              className="text-xs border-amber-600/40 text-amber-400 hover:bg-amber-600/10">
              <RefreshCw size={12} className="mr-1.5" /> Reset Arena (Restore Balance)
            </Button>
          </div>
        </div>
      )}

      {/* ── Deposit ── */}
      {tab === 'deposit' && (
        <div className="max-w-md">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Add Virtual Funds</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="px-4 py-3 rounded-xl bg-blue-500/5 border border-blue-500/20 text-xs text-blue-300">
                Virtual deposit for simulation only — no real money involved. Any amount from $1 is accepted.
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Amount (USDT) — minimum $1</Label>
                <Input value={depositAmt} onChange={e => setDepositAmt(e.target.value)}
                  placeholder="Enter any amount (e.g. 1)" type="number" min="1" step="any"
                  className="h-9 text-sm font-mono" />
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] text-zinc-500 uppercase tracking-widest">Quick amounts</p>
                <div className="flex flex-wrap gap-2">
                  {[1, 10, 50, 100, 500, 1000, 5000, 10000].map(a => (
                    <button key={a} onClick={() => setDepositAmt(String(a))}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors
                        ${depositAmt === String(a)
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                          : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}>
                      ${a.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>
              <Button onClick={handleDeposit} className="w-full"
                disabled={!depositAmt || isNaN(parseFloat(depositAmt)) || parseFloat(depositAmt) <= 0}>
                <ArrowDownCircle size={14} className="mr-2" />
                Deposit ${depositAmt && !isNaN(parseFloat(depositAmt)) ? fmt(parseFloat(depositAmt)) : '0.00'}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Withdraw ── */}
      {tab === 'withdraw' && (
        <div className="max-w-md">
          <Card className="border-zinc-800/60">
            <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Withdraw Funds</CardTitle></CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-xs text-amber-300 flex items-start gap-2">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                Withdrawals require admin approval in demo mode. Virtual only — no real funds.
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">Available balance</span>
                <span className="font-mono font-semibold">${fmt(wallet.virtualBalance - wallet.lockedBalance)}</span>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Amount (USDT)</Label>
                <Input value={withdrawAmt} onChange={e => setWithdrawAmt(e.target.value)}
                  placeholder="Enter amount" type="number" className="h-9 text-sm font-mono" />
              </div>
              <Button onClick={handleWithdraw} variant="outline" className="w-full"
                disabled={!withdrawAmt || parseFloat(withdrawAmt) <= 0 || parseFloat(withdrawAmt) > wallet.virtualBalance - wallet.lockedBalance}>
                <ArrowUpCircle size={14} className="mr-2" />
                Request Withdrawal
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── History ── */}
      {tab === 'history' && (
        <Card className="border-zinc-800/60">
          <CardHeader className="py-3 px-4"><CardTitle className="text-sm">Full Transaction History</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    {['Time', 'Type', 'Description', 'Amount', 'Balance After', 'Status'].map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentTxs.length === 0
                    ? <tr><td colSpan={6} className="px-3 py-12 text-center text-zinc-600">No transactions yet</td></tr>
                    : recentTxs.map(tx => {
                        const Icon = TX_ICONS[tx.type] || DollarSign;
                        const color = TX_COLORS[tx.type] || 'text-zinc-400';
                        const isDebit = tx.type === 'loss' || tx.type === 'trade_fee' || tx.type === 'withdrawal';
                        return (
                          <tr key={tx.id} className="border-b border-zinc-800/40 hover:bg-zinc-900/40">
                            <td className="px-3 py-2 text-zinc-500">{new Date(tx.timestamp).toLocaleString()}</td>
                            <td className="px-3 py-2">
                              <div className={`flex items-center gap-1.5 ${color}`}>
                                <Icon size={11} />
                                <span className="capitalize">{tx.type.replace('_', ' ')}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-zinc-400 max-w-48 truncate">{tx.description}</td>
                            <td className={`px-3 py-2 font-mono ${isDebit ? 'text-red-400' : 'text-emerald-400'}`}>
                              {isDebit ? '-' : '+'}${fmt(tx.amount)}
                            </td>
                            <td className="px-3 py-2 font-mono text-zinc-400">
                              {tx.balanceAfter != null ? `$${fmt(tx.balanceAfter)}` : '—'}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${STATUS_BADGE[tx.status] ?? ''}`}>{tx.status}</span>
                            </td>
                          </tr>
                        );
                      })
                  }
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
