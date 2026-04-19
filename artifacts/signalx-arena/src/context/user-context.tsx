
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import {
  loginUser, signupUser, logoutUser, loadSession,
  updateUserSettings, updateUserProfile, loginWithGoogle,
  requestPasswordReset, resetPassword,
  type UserAccount, type UserSettings,
} from '@/lib/user-store';

interface UserContextValue {
  user: UserAccount | null;
  isLoggedIn: boolean;
  isAdmin: boolean;
  isPro: boolean;
  login:                (email: string, password: string)                              => { error: string | null };
  signup:               (email: string, name: string, password: string)               => { error: string | null };
  googleLogin:          (gUser: { googleId: string; email: string; name: string; avatar?: string }) => { error: string | null };
  logout:               () => void;
  forgotPassword:       (email: string)                                               => { code: string | null; error: string | null };
  doResetPassword:      (email: string, code: string, newPassword: string)            => { error: string | null };
  updateSettings:       (settings: Partial<UserSettings>)                            => void;
  updateProfile:        (data: Partial<Pick<UserAccount, 'name' | 'email'>>)         => void;
  refresh:              () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserAccount | null>(() => loadSession());

  const login = useCallback((email: string, password: string) => {
    const { user: u, error } = loginUser(email, password);
    if (u) setUser(u);
    return { error };
  }, []);

  const signup = useCallback((email: string, name: string, password: string) => {
    const { user: u, error } = signupUser(email, name, password);
    if (u) setUser(u);
    return { error };
  }, []);

  const googleLogin = useCallback((gUser: { googleId: string; email: string; name: string; avatar?: string }) => {
    const { user: u, error } = loginWithGoogle(gUser);
    if (u) setUser(u);
    return { error };
  }, []);

  const logout = useCallback(() => {
    logoutUser();
    setUser(null);
  }, []);

  const forgotPassword = useCallback((email: string) => {
    return requestPasswordReset(email);
  }, []);

  const doResetPassword = useCallback((email: string, code: string, newPassword: string) => {
    const { user: u, error } = resetPassword(email, code, newPassword);
    if (u) setUser(u);
    return { error };
  }, []);

  const updateSettings = useCallback((settings: Partial<UserSettings>) => {
    if (!user) return;
    const updated = updateUserSettings(user.id, settings);
    if (updated) setUser(updated);
  }, [user]);

  const updateProfile = useCallback((data: Partial<Pick<UserAccount, 'name' | 'email'>>) => {
    if (!user) return;
    const updated = updateUserProfile(user.id, data);
    if (updated) setUser(updated);
  }, [user]);

  const refresh = useCallback(() => {
    const fresh = loadSession();
    setUser(fresh);
  }, []);

  return (
    <UserContext.Provider value={{
      user,
      isLoggedIn:    !!user,
      isAdmin:       user?.plan === 'admin',
      isPro:         user?.plan === 'pro' || user?.plan === 'admin',
      login, signup, googleLogin, logout,
      forgotPassword, doResetPassword,
      updateSettings, updateProfile, refresh,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be inside UserProvider');
  return ctx;
}
