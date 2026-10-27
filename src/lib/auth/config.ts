// Email verification switch. "on": sign-up, invite activation, login-by-code, password reset and
// change of email all go through an emailed 6-digit code / verify link (AUTH-01/03/04/05/13).
// Anything else (default): accounts are created and activated with a password straight away and
// no verification email is sent — for local use until a mail sender is configured.
export const emailVerificationOn = () => process.env.EMAIL_VERIFICATION === "on";
