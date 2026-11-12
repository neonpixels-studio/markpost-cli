// Markpost is invite-only during the alpha, so a new user without an account
// can't get an API token. Every place a token-less or rejected user can land
// points them at the waitlist; the copy lives here so it's defined once.
// `/sign-up` (not `/waitlist`) on purpose: the site redirects it to the
// waitlist today and can point it at real sign-up later without a CLI release.
export const WAITLIST_URL = 'https://markpost.io/sign-up';

export const WAITLIST_SENTENCE = `No account yet? Join the waitlist: ${WAITLIST_URL}`;

export const FIRST_RUN_NOTICE = [
  'Markpost is in invite-only alpha. You need an API token from an invited account.',
  WAITLIST_SENTENCE,
].join('\n');

export const AUTH_FAILURE_NOTICE = [
  'Authentication failed. Markpost is in invite-only alpha.',
  WAITLIST_SENTENCE,
  'Already invited? Check your token with `markpost config get apiToken`.',
].join('\n');

// Appends the waitlist sentence to a single-line message (the `--json`
// `message` field), keeping it one line so a consumer's parser is unaffected.
export const withWaitlistSentence = (message: string): string =>
  `${message} ${WAITLIST_SENTENCE}`;

// Whether this process got a 401/403 from the API. Recorded at the one seam
// every API failure passes through (`assertApiSuccess`), then read where the
// failure is finally reported: many callers swallow the error object and
// report a generic message, so the status code isn't available there.
let authFailureSeen = false;

export const recordAuthFailure = (): void => {
  authFailureSeen = true;
};

export const hasSeenAuthFailure = (): boolean => authFailureSeen;

export const resetAuthFailure = (): void => {
  authFailureSeen = false;
};
