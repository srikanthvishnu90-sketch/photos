// Provider boundaries live here so production auth can be connected without
// changing any splash, login, or form markup.
// Wired to Supabase auth (project: gems). OAuth providers activate as soon as
// their credentials are configured in the Supabase dashboard; until then every
// call resolves so the demo flow continues.
import { getSupabase } from "./gems-supabase.js";

// Returns { redirecting } so the caller knows the browser is navigating to the
// provider — and must NOT paint any next screen (doing so flashes onboarding
// for a frame before the redirect completes). When redirecting is false
// (offline / not configured), the caller keeps the prototype flow.
async function signInWithOAuth(provider) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return { redirecting: false };
    // Get the provider URL WITHOUT letting the SDK redirect, then navigate
    // ourselves right away. iOS Safari drops navigations that happen too far
    // from the tap; assigning window.location directly is the most reliable.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      console.info(`${provider} sign-in not available`, error);
      return { redirecting: false };
    }
    window.location.assign(data.url);
    return { redirecting: true };
  } catch (error) {
    console.info(`${provider} sign-in unavailable`, error);
    return { redirecting: false };
  }
}

export const authActions = Object.freeze({
  async signInWithApple() {
    return signInWithOAuth("apple");
  },

  async signInWithGoogle() {
    return signInWithOAuth("google");
  },

  // Resolves { sent } so the login flow knows whether to show the
  // code-entry step or continue in demo mode.
  // Resolves { sent, reason }. `reason` distinguishes the two very different
  // failures the caller must NOT treat alike: "no-backend" is the offline /
  // demo case where continuing is correct, while "rejected" means the server
  // actively refused this address and the user has to see that.
  async requestEmailOtp(email) {
    try {
      const supabase = await getSupabase();
      if (!supabase) return { sent: false, reason: "no-backend" };
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) {
        console.info("Email OTP request failed", error);
        return { sent: false, reason: "rejected", message: error.message };
      }
      return { sent: true };
    } catch (error) {
      console.info("Email OTP unavailable", error);
      return { sent: false, reason: "no-backend" };
    }
  },

  // Resolves { session } (null when the code was wrong or expired).
  async verifyEmailOtp(email, token) {
    try {
      const supabase = await getSupabase();
      if (!supabase) return { session: null };
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token,
        type: "email",
      });
      if (error) {
        console.info("Email OTP verify failed", error);
        return { session: null };
      }
      return { session: data?.session ?? null };
    } catch (error) {
      console.info("Email OTP verify unavailable", error);
      return { session: null };
    }
  },
});
