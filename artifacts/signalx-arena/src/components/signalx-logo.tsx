
// ── SignalX Logo — Pure CSS animations, zero framer-motion ────────────────────
// All animations run on the GPU compositor thread via CSS keyframes.
// No JS interpolation, no textShadow JS animation, no boxShadow JS animation.

interface SignalXLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showTagline?: boolean;
  className?: string;
}

const sizes = {
  sm: { badge: 'w-9 h-9',   xSize: 'text-2xl',  text: 'text-sm',  sub: 'text-[9px]'  },
  md: { badge: 'w-11 h-11', xSize: 'text-3xl',  text: 'text-base',sub: 'text-[10px]' },
  lg: { badge: 'w-14 h-14', xSize: 'text-4xl',  text: 'text-lg',  sub: 'text-[11px]' },
  xl: { badge: 'w-20 h-20', xSize: 'text-6xl',  text: 'text-2xl', sub: 'text-xs'     },
};

// Pure CSS spinning X — GPU-accelerated, no JS thread involvement
function SpinningX({ xSize, glow = true }: { xSize: string; glow?: boolean }) {
  return (
    <div className="signalx-x-perspective">
      <span className={`font-black text-red-500 select-none leading-none signalx-x-spin ${glow ? 'signalx-x-glow' : ''} ${xSize}`}>
        X
      </span>
    </div>
  );
}

export function SignalXBadge({ size = 'md' }: { size?: keyof typeof sizes }) {
  const s = sizes[size];
  return (
    <div className={`${s.badge} rounded-xl bg-zinc-950 border border-red-600/30 flex items-center justify-center relative overflow-hidden cursor-default select-none flex-shrink-0 signalx-badge-glow`}>
      <div className="signalx-shimmer absolute inset-0 opacity-10" style={{ background: 'linear-gradient(135deg, transparent 35%, #ef4444 50%, transparent 65%)' }} />
      <SpinningX xSize={s.xSize} />
    </div>
  );
}

export function SignalXWordmark({ size = 'md', showTagline = false, className = '' }: SignalXLogoProps) {
  const s = sizes[size];
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <SignalXBadge size={size} />
      <div className="leading-none">
        <div className={`font-black tracking-tight ${s.text} flex items-baseline gap-0`}>
          <span className="text-white">Signal</span>
          <div className="signalx-x-perspective">
            <span className={`text-red-500 font-black signalx-x-spin signalx-x-glow ${s.xSize}`}>X</span>
          </div>
        </div>
        <div className={`${s.sub} text-zinc-500 font-light tracking-widest uppercase mt-0.5`}>
          AutoPilot
        </div>
        {showTagline && (
          <div className="text-[10px] text-zinc-600 tracking-widest uppercase mt-0.5">
            Virtual · No real money
          </div>
        )}
      </div>
    </div>
  );
}

export function SignalXHero() {
  return (
    <div className="flex flex-col items-center justify-center py-8 select-none">
      <div className="flex flex-col items-center gap-2 mb-3">
        <div className="w-24 h-24 rounded-3xl bg-zinc-950 border border-red-600/30 flex items-center justify-center relative overflow-hidden signalx-badge-glow">
          <div className="signalx-shimmer absolute inset-0 opacity-10" style={{ background: 'linear-gradient(135deg, transparent 35%, #ef4444 50%, transparent 65%)' }} />
          <div className="signalx-x-perspective">
            <span className="text-7xl font-black text-red-500 leading-none signalx-x-spin signalx-x-glow-strong">X</span>
          </div>
        </div>
        <div className="flex items-baseline gap-0">
          <span className="text-4xl sm:text-5xl font-black text-white tracking-tighter">Signal</span>
          <div className="signalx-x-perspective">
            <span className="text-4xl sm:text-5xl font-black text-red-500 signalx-x-spin signalx-x-glow">X</span>
          </div>
        </div>
      </div>
      <div className="text-xs sm:text-sm font-light tracking-[0.4em] uppercase text-zinc-400">
        AI Trading Arena
      </div>
    </div>
  );
}
