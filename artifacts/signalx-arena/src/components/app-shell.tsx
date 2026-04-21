
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { SignalXWordmark } from './signalx-logo';
import { GlobalControlBar } from './control-bar';
import { useUser } from '@/context/user-context';
import { useOnlineStatus } from '@/hooks/use-online-status';
import {
  Cpu, LayoutDashboard, Stethoscope, BarChart3, Shield,
  Wallet, ArrowLeftRight, Settings, ChevronLeft, ChevronRight,
  Activity, LogOut, User, WifiOff, GitBranch,
} from 'lucide-react';

type NavItem = {
  path:     string;
  label:    string;
  icon:     React.ElementType;
  badge?:   string | null;
  primary?: boolean;
  adminOnly?: boolean;
};

const NAV: NavItem[] = [
  { path: '/',          label: 'AutoPilot',     icon: Cpu,            badge: 'AI',  primary: true  },
  { path: '/arena',     label: 'AI Arena',      icon: LayoutDashboard, badge: null  },
  { path: '/doctor',    label: 'Bot Doctor',    icon: Stethoscope,    badge: null  },
  { path: '/reports',   label: 'Reports',       icon: BarChart3,      badge: null  },
  { path: '/exchange',  label: 'Exchange',      icon: ArrowLeftRight,  badge: 'DEMO'},
  { path: '/wallet',    label: 'Wallet',        icon: Wallet,         badge: null  },
  { path: '/risk',      label: 'Risk Engine',   icon: Shield,         badge: null  },
  { path: '/status',    label: 'System Status', icon: Activity,       badge: null  },
  { path: '/pipeline',  label: 'Pipeline',      icon: GitBranch,      badge: 'NEW' },
  { path: '/admin',     label: 'Admin',         icon: Settings,       badge: null,  adminOnly: true },
];

const PLAN_COLORS: Record<string, string> = {
  free:  'text-zinc-400',
  pro:   'text-amber-400',
  admin: 'text-red-400',
};
const PLAN_BG: Record<string, string> = {
  free:  'bg-zinc-700/40',
  pro:   'bg-amber-500/15 border-amber-500/30',
  admin: 'bg-red-500/15 border-red-500/30',
};

interface AppShellProps {
  children: React.ReactNode;
  alerts?:  number;
}

export function AppShell({ children, alerts = 0 }: AppShellProps) {
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [location]  = useLocation();
  const { user, isAdmin, logout } = useUser();
  const isOnline = useOnlineStatus();

  const visibleNav = NAV.filter(item => !item.adminOnly || isAdmin);

  return (
    <div className="min-h-screen bg-background text-foreground flex">

      {/* ── Mobile backdrop ── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className="fixed inset-0 bg-black/60 z-40 lg:hidden"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ── Sidebar ── */}
      <motion.aside
        className={`
          fixed lg:sticky top-0 h-screen z-50 flex flex-col
          bg-zinc-950 border-r border-zinc-800/60
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
        animate={{ width: collapsed ? 64 : 220 }}
        transition={{ duration: 0.25, ease: 'easeInOut' }}
      >
        {/* Logo */}
        <div className={`p-3 border-b border-zinc-800/60 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && <SignalXWordmark size="sm" />}
          {collapsed && (
            <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-red-600/30 flex items-center justify-center signalx-x-glow">
              <span className="font-black text-red-500 text-sm inline-block signalx-x-spin">X</span>
            </div>
          )}
          <button
            onClick={() => setCollapsed(v => !v)}
            className="hidden lg:flex w-6 h-6 rounded border border-zinc-700 items-center justify-center text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors flex-shrink-0"
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
          </button>
        </div>

        {/* Mode badge (paper trading) */}
        {!collapsed && (
          <div className="px-3 pt-2 pb-1">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-blue-600/10 border border-blue-600/20">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              <span className="text-[9px] font-bold text-blue-400 uppercase tracking-widest">Paper Trading</span>
            </div>
          </div>
        )}

        {/* Nav links */}
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map((item, idx) => {
            const Icon   = item.icon;
            const active = location === item.path || (item.path !== '/' && location.startsWith(item.path));
            const isPri  = !!item.primary;
            return (
              <div key={item.path}>
                {idx === 1 && !collapsed && (
                  <div className="h-px bg-zinc-800/60 my-1.5" />
                )}
                {idx === visibleNav.findIndex(i => i.path === '/status') && !collapsed && (
                  <div className="h-px bg-zinc-800/60 my-1.5" />
                )}
                <Link href={item.path}>
                  <motion.div
                    onClick={() => setMobileOpen(false)}
                    className={`
                      flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer
                      transition-colors text-sm font-medium select-none
                      ${active
                        ? isPri
                          ? 'bg-red-600/20 text-red-400 border border-red-600/30'
                          : 'bg-zinc-800/70 text-zinc-100 border border-zinc-700/50'
                        : isPri
                          ? 'text-zinc-300 hover:text-red-400 hover:bg-red-600/10 border border-transparent'
                          : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'}
                      ${collapsed ? 'justify-center' : ''}
                    `}
                    whileHover={{ x: collapsed ? 0 : 2 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Icon size={14} className={
                      active ? (isPri ? 'text-red-400' : 'text-zinc-200') : (isPri ? 'text-zinc-400' : 'text-zinc-600')
                    } />
                    {!collapsed && (
                      <span className={`flex-1 truncate ${isPri ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
                    )}
                    {!collapsed && item.badge && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
                        isPri
                          ? 'bg-red-600/25 text-red-400 border border-red-600/40'
                          : 'bg-zinc-700/50 text-zinc-500 border border-zinc-700'
                      }`}>
                        {item.badge}
                      </span>
                    )}
                  </motion.div>
                </Link>
              </div>
            );
          })}
        </nav>

        {/* Bottom user section */}
        {user && !collapsed && (
          <div className="p-3 border-t border-zinc-800/60 space-y-1">
            <Link href="/profile">
              <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-zinc-800/50 cursor-pointer transition-colors group">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-red-600 to-orange-500 flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {user.avatar
                    ? <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                    : <span className="text-[11px] font-black text-white">{user.name.charAt(0).toUpperCase()}</span>
                  }
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-zinc-200 truncate group-hover:text-zinc-100">{user.name}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className={`text-[9px] px-1 py-0 rounded font-bold border ${PLAN_BG[user.plan]} ${PLAN_COLORS[user.plan]}`}>
                      {user.plan.toUpperCase()}
                    </span>
                  </div>
                </div>
                <User size={11} className="text-zinc-700 group-hover:text-zinc-500 flex-shrink-0" />
              </div>
            </Link>
            <button onClick={logout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-600/10 transition-colors text-xs">
              <LogOut size={11} />
              <span>Sign out</span>
            </button>
          </div>
        )}
        {user && collapsed && (
          <div className="p-2 border-t border-zinc-800/60 flex flex-col items-center gap-2">
            <Link href="/profile">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-red-600 to-orange-500 flex items-center justify-center cursor-pointer hover:ring-2 hover:ring-red-500/40 transition-all overflow-hidden">
                {user.avatar
                  ? <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
                  : <span className="text-xs font-black text-white">{user.name.charAt(0).toUpperCase()}</span>
                }
              </div>
            </Link>
          </div>
        )}
      </motion.aside>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Offline banner */}
        <AnimatePresence>
          {!isOnline && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-amber-500/10 border-b border-amber-500/30 overflow-hidden"
            >
              <div className="flex items-center gap-2 px-4 py-1.5">
                <WifiOff size={11} className="text-amber-400 flex-shrink-0" />
                <span className="text-[11px] text-amber-400 font-medium">
                  You're offline — simulation runs locally, live market data unavailable
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="sticky top-0 z-30">
          <GlobalControlBar
            alerts={alerts}
            onMobileOpen={() => setMobileOpen(v => !v)}
          />
        </div>
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
