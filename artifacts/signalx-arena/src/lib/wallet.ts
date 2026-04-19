
// ─── Wallet & Transaction Ledger ──────────────────────────────────────────────

export type TxType = 'deposit' | 'withdrawal' | 'trade_fee' | 'profit' | 'loss' | 'transfer';
export type TxStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

export interface Transaction {
  id: string;
  type: TxType;
  amount: number;
  currency: string;
  status: TxStatus;
  timestamp: number;
  description: string;
  reference?: string;
  fee?: number;
  balanceAfter?: number;
  adminNote?: string;
}

export interface WalletState {
  virtualBalance: number;
  lockedBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalFeesPaid: number;
  totalPnl: number;
  transactions: Transaction[];
  lastUpdated: number;
}

const WALLET_KEY = 'sx_wallet';

export function loadWallet(): WalletState {
  try {
    const r = localStorage.getItem(WALLET_KEY);
    if (r) return JSON.parse(r);
  } catch {}
  return initWallet();
}

function initWallet(): WalletState {
  const txs: Transaction[] = [
    {
      id: 'tx_init_1',
      type: 'deposit',
      amount: 50000,
      currency: 'USD',
      status: 'completed',
      timestamp: Date.now() - 30 * 86_400_000,
      description: 'Initial virtual deposit',
      balanceAfter: 50000,
    },
    ...generateMockHistory(),
  ];
  return {
    virtualBalance: 50000,
    lockedBalance: 0,
    totalDeposited: 50000,
    totalWithdrawn: 0,
    totalFeesPaid: txs.filter(t => t.type === 'trade_fee').reduce((s, t) => s + t.amount, 0),
    totalPnl: 0,
    transactions: txs,
    lastUpdated: Date.now(),
  };
}

function generateMockHistory(): Transaction[] {
  const txs: Transaction[] = [];
  const now = Date.now();
  const types: TxType[] = ['trade_fee', 'profit', 'loss', 'trade_fee', 'profit'];
  const labels = ['Bot BTC Sniper', 'Bot ETH Blitz', 'Bot SOL Rocket', 'Bot DOGE Hunter', 'Bot NVDA Alpha'];
  let balance = 50000;

  for (let i = 0; i < 20; i++) {
    const type = types[i % types.length];
    const isPositive = type === 'profit' || type === 'deposit';
    const amount = Math.abs((Math.random() * 80 + 5) * (isPositive ? 1 : -1));
    balance += amount;
    txs.push({
      id: `tx_hist_${i}`,
      type,
      amount: Math.abs(amount),
      currency: 'USDT',
      status: 'completed',
      timestamp: now - (20 - i) * 3_600_000,
      description: `${type === 'trade_fee' ? 'Fee:' : type === 'profit' ? 'Profit:' : 'Loss:'} ${labels[i % labels.length]}`,
      balanceAfter: balance,
    });
  }
  return txs;
}

export function saveWallet(w: WalletState) {
  localStorage.setItem(WALLET_KEY, JSON.stringify(w));
}

export function requestDeposit(
  wallet: WalletState,
  amount: number,
  currency = 'USDT',
): WalletState {
  const tx: Transaction = {
    id: `tx_dep_${Date.now()}`,
    type: 'deposit',
    amount,
    currency,
    status: 'pending',
    timestamp: Date.now(),
    description: `Deposit request: ${amount} ${currency}`,
    balanceAfter: wallet.virtualBalance + amount,
  };
  const updated: WalletState = {
    ...wallet,
    virtualBalance: wallet.virtualBalance + amount,
    totalDeposited: wallet.totalDeposited + amount,
    transactions: [...wallet.transactions, tx],
    lastUpdated: Date.now(),
  };
  saveWallet(updated);
  return updated;
}

export function requestWithdrawal(
  wallet: WalletState,
  amount: number,
  currency = 'USDT',
): { wallet: WalletState; error?: string } {
  if (amount > wallet.virtualBalance - wallet.lockedBalance) {
    return { wallet, error: 'Insufficient available balance' };
  }
  const tx: Transaction = {
    id: `tx_wd_${Date.now()}`,
    type: 'withdrawal',
    amount,
    currency,
    status: 'pending',
    timestamp: Date.now(),
    description: `Withdrawal request: ${amount} ${currency} (pending admin approval)`,
    balanceAfter: wallet.virtualBalance - amount,
  };
  const updated: WalletState = {
    ...wallet,
    virtualBalance: wallet.virtualBalance - amount,
    lockedBalance: wallet.lockedBalance + amount,
    totalWithdrawn: wallet.totalWithdrawn + amount,
    transactions: [...wallet.transactions, tx],
    lastUpdated: Date.now(),
  };
  saveWallet(updated);
  return { wallet: updated };
}
