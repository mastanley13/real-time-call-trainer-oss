/** Password reset contract shared by the API routes and the pages. Client-safe. */

/** How long a reset link works. The single source: the token TTL and every user-facing "expires in" string derive from it. */
export const RESET_TTL_MINUTES = 15;

/** The one message every accepted reset request gets, whether or not the account exists. */
export const RESET_REQUEST_MESSAGE = `If an account exists for that email, we sent a link. It expires in ${RESET_TTL_MINUTES} minutes.`;

export const RESET_INVALID_MESSAGE = "This reset link is invalid or has expired. Request a new one.";

export const RESET_NO_DATABASE_MESSAGE = "Password reset needs a database. Set DATABASE_URL on the server.";
