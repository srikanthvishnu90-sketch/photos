// Provider boundaries live here so production auth can be connected without
// changing any splash, login, or form markup.
// Wired to Supabase auth (project: gems). OAuth providers activate as soon as
// their credentials are configured in the Supabase dashboard; until then every
// call resolves so the demo flow continues.
import { getSupabase } from "./gems-supabase.js";

async function signInWithOAuth(provider) {
  try {
    const supabase = await getSupabase();
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) console.info(`${provider} sign-in not configured yet`, error);
  } catch (error) {
    console.info(`${provider} sign-in unavailable`, error);
  }
}

export const authActions = Object.freeze({
  async signInWithApple() {
    await signInWithOAuth("apple");
  },

  async signInWithGoogle() {
    await signInWithOAuth("google");
  },

  async requestEmailOtp(email) {
    try {
      const supabase = await getSupabase();
      if (!supabase) return;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) console.info("Email OTP request failed", error);
    } catch (error) {
      console.info("Email OTP unavailable", error);
    }
  },
});
