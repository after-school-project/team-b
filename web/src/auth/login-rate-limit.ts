/**
 * Login attempts allowed per client IP in each fixed 60-second window (see rate-limit-storage.ts).
 * School NATs put about 300 students and alumni on one IP, so the limit lets all of them sign in
 * within one minute. Issued passwords are 144-bit random values, so a higher limit does not make
 * online guessing practical.
 */
export const loginRateLimit: { window: number; max: number } = { window: 60, max: 300 };
