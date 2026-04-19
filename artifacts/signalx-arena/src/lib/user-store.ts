
// ── SignalX User Account Store ────────────────────────────────────────────────
// All local-first: localStorage only. No backend required.
// This is a paper trading / simulation platform — no real money involved.

export type UserPlan = 'free' | 'pro' | 'admin';
export type TradingMode = 'paper' | 'live_ready';
export type RiskPreference = 'conservative' | 'moderate' | 'aggressive';

export interface UserSettings {
  tradingMode: TradingMode;
  riskPreference: RiskPreference;
  defaultBotCount: number;
  notifications: boolean;
  binanceApiKeyMasked: string;
  binanceSecretMasked: string;
  binanceConnected: boolean;
  binanceTestnet: boolean;
}

export interface UserAccount {
  id: string;
  email: string;
  name: string;
  plan: UserPlan;
  passwordHash: string;
  createdAt: number;
  lastLogin: number;
  settings: UserSettings;
  googleId?: string;
  avatar?: string;
}

export const PLAN_FEATURES: Record<UserPlan, { label: string; color: string; features: string[] }> = {
  free: {
    label: 'Free',
    color: 'text-zinc-400',
    features: ['Up to 10 bots', 'Basic AutoPilot', 'Reports (7 days)', 'Paper trading only'],
  },
  pro: {
    label: 'Pro',
    color: 'text-amber-400',
    features: ['Up to 50 bots', 'Full AutoPilot', 'Unlimited reports', 'API connection ready', 'Priority support'],
  },
  admin: {
    label: 'Admin',
    color: 'text-red-400',
    features: ['All Pro features', 'Admin panel', 'System config', 'All bot types'],
  },
};

const USERS_KEY        = 'sx_user_accounts';
const SESSION_KEY      = 'sx_session_v2';
const RESET_TOKENS_KEY = 'sx_reset_tokens';

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36) + s.length.toString(36);
}

export const DEFAULT_SETTINGS: UserSettings = {
  tradingMode:         'paper',
  riskPreference:      'moderate',
  defaultBotCount:     30,
  notifications:       true,
  binanceApiKeyMasked: '',
  binanceSecretMasked: '',
  binanceConnected:    false,
  binanceTestnet:      true,
};

const SEED_ACCOUNTS: UserAccount[] = [
  {
    id:           'user_demo',
    email:        'demo@signalx.ai',
    name:         'Demo Trader',
    plan:         'pro',
    passwordHash: simpleHash('demo123'),
    createdAt:    Date.now() - 30 * 86_400_000,
    lastLogin:    Date.now(),
    settings:     { ...DEFAULT_SETTINGS, defaultBotCount: 30 },
  },
  {
    id:           'user_admin',
    email:        'admin@signalx.ai',
    name:         'Arena Admin',
    plan:         'admin',
    passwordHash: simpleHash('admin123'),
    createdAt:    Date.now() - 90 * 86_400_000,
    lastLogin:    Date.now(),
    settings:     { ...DEFAULT_SETTINGS, defaultBotCount: 40 },
  },
];

function loadUsers(): UserAccount[] {
  try {
    const raw   = localStorage.getItem(USERS_KEY);
    const saved: UserAccount[] = raw ? JSON.parse(raw) : [];
    const ids   = new Set(saved.map(u => u.id));
    const merged = [...saved];
    for (const d of SEED_ACCOUNTS) {
      if (!ids.has(d.id)) merged.push(d);
    }
    return merged;
  } catch {
    return [...SEED_ACCOUNTS];
  }
}

function saveUsers(users: UserAccount[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function loginUser(
  email: string,
  password: string,
): { user: UserAccount | null; error: string | null } {
  if (!email.trim() || !password) return { user: null, error: 'Please enter your email and password.' };
  const users = loadUsers();
  const hash  = simpleHash(password);
  const match = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase() && u.passwordHash === hash);
  if (!match) return { user: null, error: 'Invalid email or password.' };
  const updated = { ...match, lastLogin: Date.now() };
  saveUsers(users.map(u => (u.id === updated.id ? updated : u)));
  localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  return { user: updated, error: null };
}

export function signupUser(
  email: string,
  name: string,
  password: string,
): { user: UserAccount | null; error: string | null } {
  if (!email.trim() || !name.trim() || !password) return { user: null, error: 'All fields are required.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { user: null, error: 'Please enter a valid email address.' };
  if (password.length < 6) return { user: null, error: 'Password must be at least 6 characters.' };
  const users = loadUsers();
  if (users.find(u => u.email.toLowerCase() === email.trim().toLowerCase())) {
    return { user: null, error: 'This email is already registered.' };
  }
  const newUser: UserAccount = {
    id:           `user_${Date.now()}`,
    email:        email.trim().toLowerCase(),
    name:         name.trim(),
    plan:         'free',
    passwordHash: simpleHash(password),
    createdAt:    Date.now(),
    lastLogin:    Date.now(),
    settings:     { ...DEFAULT_SETTINGS },
  };
  saveUsers([...users, newUser]);
  localStorage.setItem(SESSION_KEY, JSON.stringify(newUser));
  return { user: newUser, error: null };
}

// ── Google OAuth login ─────────────────────────────────────────────────────────
export function loginWithGoogle(googleUser: {
  googleId: string;
  email: string;
  name: string;
  avatar?: string;
}): { user: UserAccount | null; error: string | null } {
  if (!googleUser.email || !googleUser.googleId) {
    return { user: null, error: 'Google sign-in failed. Please try again.' };
  }
  const users = loadUsers();
  const email = googleUser.email.toLowerCase();

  // Check if a user with this Google ID already exists
  let existing = users.find(u => u.googleId === googleUser.googleId);

  // Fall back: same email already registered manually
  if (!existing) {
    existing = users.find(u => u.email === email);
  }

  if (existing) {
    // Update Google metadata and log in
    const updated: UserAccount = {
      ...existing,
      googleId:  googleUser.googleId,
      avatar:    googleUser.avatar ?? existing.avatar,
      lastLogin: Date.now(),
    };
    saveUsers(users.map(u => (u.id === updated.id ? updated : u)));
    localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
    return { user: updated, error: null };
  }

  // Create new account from Google info
  const newUser: UserAccount = {
    id:           `user_g_${googleUser.googleId}`,
    email,
    name:         googleUser.name,
    plan:         'free',
    passwordHash: '',
    createdAt:    Date.now(),
    lastLogin:    Date.now(),
    settings:     { ...DEFAULT_SETTINGS },
    googleId:     googleUser.googleId,
    avatar:       googleUser.avatar,
  };
  saveUsers([...users, newUser]);
  localStorage.setItem(SESSION_KEY, JSON.stringify(newUser));
  return { user: newUser, error: null };
}

// ── Forgot / Reset Password ────────────────────────────────────────────────────
interface ResetToken {
  token: string;
  expiry: number;
}

function loadResetTokens(): Record<string, ResetToken> {
  try {
    const raw = localStorage.getItem(RESET_TOKENS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveResetTokens(tokens: Record<string, ResetToken>) {
  localStorage.setItem(RESET_TOKENS_KEY, JSON.stringify(tokens));
}

/** Generate a 6-digit reset code for the given email. Returns code or error. */
export function requestPasswordReset(email: string): { code: string | null; error: string | null } {
  if (!email.trim()) return { code: null, error: 'Please enter your email address.' };
  const users = loadUsers();
  const user  = users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
  if (!user) return { code: null, error: 'No account found with that email address.' };

  const code   = Math.floor(100000 + Math.random() * 900000).toString();
  const tokens = loadResetTokens();
  tokens[email.trim().toLowerCase()] = {
    token:  simpleHash(code),
    expiry: Date.now() + 15 * 60 * 1000, // 15 minutes
  };
  saveResetTokens(tokens);
  return { code, error: null };
}

/** Verify a reset code and set a new password. */
export function resetPassword(
  email: string,
  code: string,
  newPassword: string,
): { user: UserAccount | null; error: string | null } {
  if (!email.trim() || !code.trim() || !newPassword) {
    return { user: null, error: 'All fields are required.' };
  }
  if (newPassword.length < 6) {
    return { user: null, error: 'Password must be at least 6 characters.' };
  }

  const tokens = loadResetTokens();
  const entry  = tokens[email.trim().toLowerCase()];

  if (!entry) return { user: null, error: 'No reset request found. Please request a new code.' };
  if (Date.now() > entry.expiry) {
    return { user: null, error: 'Reset code has expired. Please request a new one.' };
  }
  if (entry.token !== simpleHash(code.trim())) {
    return { user: null, error: 'Invalid reset code. Please check and try again.' };
  }

  const users = loadUsers();
  const idx   = users.findIndex(u => u.email.toLowerCase() === email.trim().toLowerCase());
  if (idx === -1) return { user: null, error: 'Account not found.' };

  const updated: UserAccount = { ...users[idx], passwordHash: simpleHash(newPassword) };
  users[idx] = updated;
  saveUsers(users);

  // Clear used token
  delete tokens[email.trim().toLowerCase()];
  saveResetTokens(tokens);

  // Log in automatically
  localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  return { user: updated, error: null };
}

// ── Session ────────────────────────────────────────────────────────────────────
export function loadSession(): UserAccount | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: UserAccount = JSON.parse(raw);
    const fresh = loadUsers().find(u => u.id === session.id);
    return fresh ?? null;
  } catch {
    return null;
  }
}

export function logoutUser() {
  localStorage.removeItem(SESSION_KEY);
}

export function updateUserSettings(userId: string, settings: Partial<UserSettings>): UserAccount | null {
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  const updated = { ...users[idx], settings: { ...users[idx].settings, ...settings } };
  users[idx] = updated;
  saveUsers(users);
  localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  return updated;
}

export function updateUserProfile(userId: string, data: Partial<Pick<UserAccount, 'name' | 'email'>>): UserAccount | null {
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  const updated = { ...users[idx], ...data };
  users[idx] = updated;
  saveUsers(users);
  localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  return updated;
}
