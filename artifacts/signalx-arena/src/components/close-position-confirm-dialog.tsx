import { Wallet } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ClosePositionPlan } from '@/lib/close-position-dialog';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export interface ClosePositionConfirmDialogProps {
  open:      boolean;
  plan:      ClosePositionPlan;
  onCancel:  () => void;
  onConfirm: (asset: string) => void;
}

// Per-asset "Confirm close position" dialog shown on the Balances tab in
// Real mode. Extracted out of pages/exchange.tsx so the open / cancel /
// confirm wiring can be exercised with React Testing Library — a regression
// in the JSX (wrong handler, wrong testid, dialog stuck open) would
// otherwise only surface in production.
export function ClosePositionConfirmDialog(props: ClosePositionConfirmDialogProps) {
  const { open, plan, onCancel, onConfirm } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onCancel(); }}
    >
      <DialogContent className="border-amber-500/40" data-testid="dialog-close-position">
        <DialogHeader>
          <DialogTitle className="text-amber-300 flex items-center gap-2">
            <Wallet size={16} />
            Close {plan.asset} position on {plan.exchangeName}?
          </DialogTitle>
          <DialogDescription className="text-zinc-300">
            This submits a <span className="font-semibold text-amber-300">MARKET SELL</span>{' '}
            through the trading engine. The size is governed by your
            Trade Config (not the full balance) so risk caps still
            apply. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div
          className="rounded-md border border-zinc-800/60 bg-zinc-950/40 divide-y divide-zinc-800/60"
          data-testid="list-close-position-asset"
        >
          <div
            className="flex items-center justify-between px-3 py-2 text-xs"
            data-testid={`row-close-position-${plan.asset}`}
          >
            <span className="font-mono font-semibold text-zinc-100">{plan.asset}</span>
            <span className="text-zinc-400">
              <span data-testid="text-close-position-available">{fmt(plan.available, 6)}</span>
              <span className="text-zinc-600 mx-1">{'\u2192'}</span>
              <span className="text-amber-300 font-semibold">
                {typeof plan.usdValue === 'number' ? `\u2248 $${fmt(plan.usdValue)}` : '\u2248 $\u2014'}
              </span>
              <span className="text-zinc-500"> on {plan.exchangeName}</span>
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel}
            data-testid="button-close-position-cancel"
          >
            Keep position
          </Button>
          <Button
            variant="default"
            className="bg-amber-500 text-zinc-950 hover:bg-amber-400"
            disabled={!plan.asset}
            onClick={() => onConfirm(plan.asset)}
            data-testid="button-close-position-confirm"
          >
            Close {plan.asset}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
