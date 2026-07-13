/**
 * Result<T, E> — explicit success/failure without exceptions for expected
 * failure paths (validation, gating, provider outages). Exceptions remain
 * for programmer errors; Results are for the domain saying "no".
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export const map = <T, E, U>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
    r.ok ? ok(fn(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
    r.ok ? r : err(fn(r.error));

export const andThen = <T, E, U>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> =>
    r.ok ? fn(r.value) : r;

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);
