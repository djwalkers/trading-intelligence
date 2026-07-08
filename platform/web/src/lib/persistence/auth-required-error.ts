// Thrown by SupabasePaperTradeStore when an operation is attempted with no valid session —
// either the user was never signed in, or their session has since expired. Distinguished from a
// generic Supabase failure so ResilientPaperTradeStore can treat it differently: falling back to
// local storage would be wrong here (it would silently start saving to an unscoped store instead
// of telling the user they need to sign in again).
export class AuthRequiredError extends Error {
  constructor(message = "Not authenticated — sign in to save paper trades.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}
