import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClosePositionConfirmDialog } from './close-position-confirm-dialog';
import {
  cancelClosePositionDialog,
  confirmClosePositionDialog,
  initialClosePositionDialogState,
  openClosePositionDialog,
  type ClosePositionPlan,
} from '@/lib/close-position-dialog';

// Render tests for the per-asset close-position confirmation dialog.
// The pure helpers + state machine are covered by close-position-dialog
// unit tests; these tests guard the JSX wiring (open trigger, cancel /
// confirm handlers, testids) so a regression in the markup can't ship
// undetected.

const PLAN: ClosePositionPlan = {
  exchangeId:   'binance',
  exchangeName: 'Binance',
  asset:        'SHIB',
  available:    1234.5,
  usdValue:     42.42,
};

afterEach(() => cleanup());

describe('<ClosePositionConfirmDialog />', () => {
  it('does not render the dialog content when open is false', () => {
    render(
      <ClosePositionConfirmDialog
        open={false}
        plan={PLAN}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('dialog-close-position')).toBeNull();
    expect(screen.queryByTestId('button-close-position-confirm')).toBeNull();
  });

  it('renders the dialog with asset, exchange, qty, and USD value when open', () => {
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={PLAN}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dialog-close-position')).toBeTruthy();
    expect(screen.getByTestId('row-close-position-SHIB')).toBeTruthy();
    expect(screen.getByTestId('text-close-position-available').textContent)
      .toBe('1,234.500000');
    // The dialog should reference the asset and exchange in user-facing copy.
    expect(screen.getByTestId('dialog-close-position').textContent)
      .toContain('Close SHIB position on Binance');
    expect(screen.getByTestId('dialog-close-position').textContent)
      .toContain('$42.42');
  });

  it('cancel button calls onCancel and never calls onConfirm', async () => {
    const onCancel  = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={PLAN}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByTestId('button-close-position-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm button forwards the asset to onConfirm exactly once', async () => {
    const onCancel  = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={PLAN}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByTestId('button-close-position-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('SHIB');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('clicking confirm twice fires onConfirm once per click (no auto-suppress)', async () => {
    // The dialog itself does not gate double-click; the parent state
    // machine handles that via cancelClosePositionDialog after confirm.
    // We just want to make sure the click handler is wired straight to
    // onConfirm and not swallowed by some inner element.
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={PLAN}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const btn = screen.getByTestId('button-close-position-confirm');
    await user.click(btn);
    await user.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenNthCalledWith(1, 'SHIB');
    expect(onConfirm).toHaveBeenNthCalledWith(2, 'SHIB');
  });

  it('confirm button is disabled (and onConfirm never fires) when the asset is empty', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={{ ...PLAN, asset: '' }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const btn = screen.getByTestId('button-close-position-confirm') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the em-dash USD placeholder when usdValue is missing', () => {
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={{ ...PLAN, usdValue: undefined }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('row-close-position-SHIB').textContent)
      .toContain('\u2248 $\u2014');
  });

  it('clicking Cancel in a stateful wrapper actually unmounts the dialog', async () => {
    // End-to-end stateful check: parent owns the same state machine the
    // page uses. Clicking the cancel button must flip `open` to false and
    // remove the dialog from the DOM, not just fire a callback.
    function Harness() {
      const [state, setState] = useState(() => openClosePositionDialog('SHIB'));
      const plan: ClosePositionPlan = {
        exchangeId:   'binance',
        exchangeName: 'Binance',
        asset:        state.asset || 'SHIB',
        available:    1234.5,
        usdValue:     42.42,
      };
      return (
        <ClosePositionConfirmDialog
          open={state.open}
          plan={plan}
          onCancel={() => setState(cancelClosePositionDialog())}
          onConfirm={() => {
            const { next } = confirmClosePositionDialog(state);
            setState(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('dialog-close-position')).toBeTruthy();
    await user.click(screen.getByTestId('button-close-position-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('dialog-close-position')).toBeNull();
    });
  });

  it('clicking Confirm in a stateful wrapper unmounts the dialog (matches state machine)', async () => {
    function Harness() {
      const [state, setState] = useState(() => openClosePositionDialog('SHIB'));
      const plan: ClosePositionPlan = {
        exchangeId:   'binance',
        exchangeName: 'Binance',
        asset:        state.asset || 'SHIB',
        available:    1.0,
        usdValue:     1.0,
      };
      return (
        <ClosePositionConfirmDialog
          open={state.open}
          plan={plan}
          onCancel={() => setState(cancelClosePositionDialog())}
          onConfirm={() => {
            const { next } = confirmClosePositionDialog(state);
            setState(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('dialog-close-position')).toBeTruthy();
    await user.click(screen.getByTestId('button-close-position-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('dialog-close-position')).toBeNull();
    });
    // Sanity: the initial state machine value is what we expect.
    expect(initialClosePositionDialogState.open).toBe(false);
  });

  it('pressing Escape inside the open dialog routes to onCancel (not onConfirm)', async () => {
    const onCancel  = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ClosePositionConfirmDialog
        open={true}
        plan={PLAN}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
