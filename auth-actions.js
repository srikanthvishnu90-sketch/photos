// Provider boundaries live here so production auth can be connected without
// changing any splash, login, or form markup.
export const authActions = Object.freeze({
  async signInWithApple() {
    // TODO: auth — attach Sign in with Apple.
    console.info("TODO: Sign in with Apple");
  },

  async signInWithGoogle() {
    // TODO: auth — attach Google Sign-In.
    console.info("TODO: Google Sign-In");
  },

  async requestEmailOtp(email) {
    // TODO: auth — send an email OTP to `email`.
    console.info(`TODO: Send email OTP to ${email}`);
  },
});
