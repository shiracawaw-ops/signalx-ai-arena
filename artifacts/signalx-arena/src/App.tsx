
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
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
        <Route component={NotFound} />
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
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
            </ArenaProvider>
          </UserProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </GoogleOAuthProvider>
  );
}

export default App;
