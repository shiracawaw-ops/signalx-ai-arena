
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArenaProvider } from "@/context/arena-context";
import { UserProvider, useUser } from "@/context/user-context";
import { AppShell } from "@/components/app-shell";
import AutoPilotPage      from "@/pages/autopilot";
import ArenaPage          from "@/pages/arena";
import BotDoctorPage      from "@/pages/bot-doctor";
import ReportsPage        from "@/pages/reports";
import AdminPage          from "@/pages/admin";
import ExchangePage       from "@/pages/exchange";
import WalletPage         from "@/pages/wallet";
import RiskPage           from "@/pages/risk";
import ProfilePage        from "@/pages/profile";
import StatusPage         from "@/pages/status";
import LoginPage          from "@/pages/auth/login";
import SignupPage         from "@/pages/auth/signup";
import ForgotPasswordPage from "@/pages/auth/forgot-password";
import ResetPasswordPage  from "@/pages/auth/reset-password";
import NotFound           from "@/pages/not-found";

const queryClient = new QueryClient();
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

// ─── Electron / file:// detection ────────────────────────────────────────────
// Under the file:// protocol window.location.pathname holds the absolute path
// to index.html (e.g. "/C:/.../resources/frontend/index.html") which can never
// match a route like "/login". We switch wouter to hash-based routing so the
// router reads from window.location.hash instead.
const IS_ELECTRON =
  import.meta.env.VITE_IS_ELECTRON === "true" ||
  (typeof window !== "undefined" && window.location.protocol === "file:");

function NoRouteFallback() {
  const [loc] = useLocation();
  return (
    <div
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        background: "#09090b",
        color: "#fca5a5",
        padding: 24,
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <h1 style={{ color: "#ef4444", fontSize: 18, margin: "0 0 12px" }}>
        SignalX — No route matched
      </h1>
      <p style={{ color: "#a1a1aa", fontSize: 13, margin: "0 0 12px" }}>
        The renderer mounted but no route was matched. This usually means the
        router base path is wrong for this environment.
      </p>
      <pre
        style={{
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: 14,
          fontSize: 12,
          color: "#fecaca",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {`href:     ${typeof window !== "undefined" ? window.location.href : "n/a"}
pathname: ${typeof window !== "undefined" ? window.location.pathname : "n/a"}
hash:     ${typeof window !== "undefined" ? window.location.hash : "n/a"}
wouter:   ${loc}
electron: ${IS_ELECTRON}`}
      </pre>
    </div>
  );
}

function Router() {
  const { isLoggedIn, isAdmin } = useUser();

  if (!isLoggedIn) {
    return (
      <Switch>
        <Route path="/login"           component={LoginPage}          />
        <Route path="/signup"          component={SignupPage}         />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password"  component={ResetPasswordPage}  />
        <Route><Redirect to="/login" /></Route>
      </Switch>
    );
  }

  return (
    <AppShell alerts={2}>
      <Switch>
        <Route path="/"         component={AutoPilotPage} />
        <Route path="/arena"    component={ArenaPage}     />
        <Route path="/doctor"   component={BotDoctorPage} />
        <Route path="/reports"  component={ReportsPage}   />
        <Route path="/exchange" component={ExchangePage}  />
        <Route path="/wallet"   component={WalletPage}    />
        <Route path="/risk"     component={RiskPage}      />
        <Route path="/profile"  component={ProfilePage}   />
        <Route path="/status"   component={StatusPage}    />
        {isAdmin && <Route path="/admin" component={AdminPage} />}
        <Route component={IS_ELECTRON ? NoRouteFallback : NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID ?? ''}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <UserProvider>
            <ArenaProvider>
              {IS_ELECTRON ? (
                <WouterRouter hook={useHashLocation} base="">
                  <Router />
                </WouterRouter>
              ) : (
                <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <Router />
                </WouterRouter>
              )}
            </ArenaProvider>
          </UserProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </GoogleOAuthProvider>
  );
}

export default App;
