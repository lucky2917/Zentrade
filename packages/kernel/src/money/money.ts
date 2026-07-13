/**
 * Money — immutable integer arithmetic in currency minor units.
 *
 * Constitutional rules this type enforces:
 *  - amounts are integers (bigint) in minor units; floats never enter the ledger
 *  - cross-currency arithmetic throws — there is no implicit conversion
 *  - division requires an explicit rounding mode; there is no default rounding
 *  - negative amounts are legal (balances can go negative by design)
 *
 * Scale registry covers the constitution's future markets (JPY 0dp, BTC 8dp).
 * Adding a currency is a registry entry, never a code change elsewhere.
 */

export const CURRENCY_SCALES = {
    INR: 2,
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    BTC: 8,
} as const;

export type CurrencyCode = keyof typeof CURRENCY_SCALES;

export type RoundingMode = "CEIL" | "FLOOR" | "HALF_UP";

export class CurrencyMismatchError extends Error {
    constructor(a: CurrencyCode, b: CurrencyCode) {
        super(`currency mismatch: ${a} vs ${b}`);
        this.name = "CurrencyMismatchError";
    }
}

export class MoneyRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MoneyRangeError";
    }
}

/**
 * Integer division with an explicit rounding mode.
 *  - CEIL     rounds toward +Infinity   (matches Math.ceil on rationals)
 *  - FLOOR    rounds toward -Infinity   (matches Math.floor)
 *  - HALF_UP  rounds halves away from zero (2.5 -> 3, -2.5 -> -3)
 */
export const roundDiv = (numerator: bigint, denominator: bigint, mode: RoundingMode): bigint => {
    if (denominator === 0n) throw new MoneyRangeError("division by zero");
    // normalise so the denominator is positive
    if (denominator < 0n) {
        numerator = -numerator;
        denominator = -denominator;
    }
    const quotient = numerator / denominator; // truncates toward zero
    const remainder = numerator % denominator;
    if (remainder === 0n) return quotient;

    switch (mode) {
        case "CEIL":
            return remainder > 0n ? quotient + 1n : quotient;
        case "FLOOR":
            return remainder < 0n ? quotient - 1n : quotient;
        case "HALF_UP": {
            const twiceAbsRemainder = 2n * (remainder < 0n ? -remainder : remainder);
            if (twiceAbsRemainder >= denominator) {
                return remainder > 0n ? quotient + 1n : quotient - 1n;
            }
            return quotient;
        }
    }
};

const assertSafeInteger = (value: number, what: string): void => {
    if (!Number.isSafeInteger(value)) {
        throw new MoneyRangeError(`${what} must be a safe integer, got ${value}`);
    }
};

export class Money {
    private constructor(
        readonly minor: bigint,
        readonly currency: CurrencyCode,
    ) {
        Object.freeze(this);
    }

    /** Construct from minor units (paise, cents, satoshi). */
    static fromMinor(minor: bigint | number, currency: CurrencyCode): Money {
        if (typeof minor === "number") {
            assertSafeInteger(minor, "minor amount");
            minor = BigInt(minor);
        }
        return new Money(minor, currency);
    }

    /**
     * Construct from a decimal string in major units ("1500.50").
     * Strings only — a float major amount is exactly the bug this type exists
     * to prevent. Rejects more fractional digits than the currency's scale.
     */
    static fromDecimalString(text: string, currency: CurrencyCode): Money {
        const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
        if (!match) throw new MoneyRangeError(`not a decimal amount: "${text}"`);
        const [, sign, whole, frac = ""] = match;
        const scale = CURRENCY_SCALES[currency];
        if (frac.length > scale) {
            throw new MoneyRangeError(`"${text}" has more than ${scale} fractional digits for ${currency}`);
        }
        const minor = BigInt(whole!) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0") || "0");
        return new Money(sign === "-" ? -minor : minor, currency);
    }

    static zero(currency: CurrencyCode): Money {
        return new Money(0n, currency);
    }

    get scale(): number {
        return CURRENCY_SCALES[this.currency];
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.minor + other.minor, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.minor - other.minor, this.currency);
    }

    /** Multiply by an integer quantity (shares, lots). Exact. */
    multiply(quantity: bigint | number): Money {
        if (typeof quantity === "number") {
            assertSafeInteger(quantity, "quantity");
            quantity = BigInt(quantity);
        }
        return new Money(this.minor * quantity, this.currency);
    }

    /** Divide by an integer with an explicit rounding mode. */
    divide(divisor: bigint | number, mode: RoundingMode): Money {
        if (typeof divisor === "number") {
            assertSafeInteger(divisor, "divisor");
            divisor = BigInt(divisor);
        }
        return new Money(roundDiv(this.minor, divisor, mode), this.currency);
    }

    /**
     * Apply an exact rational rate: amount * numerator / denominator.
     * This is how spreads and ratios stay float-free
     * (e.g. a 0.1% buy spread is applyRatio(1001, 1000, mode)).
     */
    applyRatio(numerator: bigint | number, denominator: bigint | number, mode: RoundingMode): Money {
        if (typeof numerator === "number") {
            assertSafeInteger(numerator, "ratio numerator");
            numerator = BigInt(numerator);
        }
        if (typeof denominator === "number") {
            assertSafeInteger(denominator, "ratio denominator");
            denominator = BigInt(denominator);
        }
        return new Money(roundDiv(this.minor * numerator, denominator, mode), this.currency);
    }

    negate(): Money {
        return new Money(-this.minor, this.currency);
    }

    abs(): Money {
        return this.minor < 0n ? this.negate() : this;
    }

    isZero(): boolean {
        return this.minor === 0n;
    }

    isNegative(): boolean {
        return this.minor < 0n;
    }

    equals(other: Money): boolean {
        return this.currency === other.currency && this.minor === other.minor;
    }

    /** -1 | 0 | 1; throws on currency mismatch. */
    compare(other: Money): -1 | 0 | 1 {
        this.assertSameCurrency(other);
        return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
    }

    lessThan(other: Money): boolean {
        return this.compare(other) < 0;
    }

    greaterThanOrEqual(other: Money): boolean {
        return this.compare(other) >= 0;
    }

    /** Minor units as a JS number; throws outside the safe-integer range. */
    toMinorNumber(): number {
        const n = Number(this.minor);
        if (!Number.isSafeInteger(n)) {
            throw new MoneyRangeError(`minor amount ${this.minor} exceeds Number safe range`);
        }
        return n;
    }

    /** Canonical decimal string in major units, e.g. "-1500.50", "0.00000001". */
    toDecimalString(): string {
        const scale = BigInt(this.scale);
        const base = 10n ** scale;
        const abs = this.minor < 0n ? -this.minor : this.minor;
        const whole = abs / base;
        const frac = abs % base;
        const sign = this.minor < 0n ? "-" : "";
        if (this.scale === 0) return `${sign}${whole}`;
        return `${sign}${whole}.${frac.toString().padStart(this.scale, "0")}`;
    }

    toString(): string {
        return `${this.currency} ${this.toDecimalString()}`;
    }

    toJSON(): { currency: CurrencyCode; minor: string } {
        return { currency: this.currency, minor: this.minor.toString() };
    }
}
