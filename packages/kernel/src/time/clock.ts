/**
 * Clock — injectable time. Domain code never calls `new Date()` directly;
 * it receives a Clock so replay (M21) and tests can pin the moment exactly.
 */

export interface Clock {
    now(): Date;
}

export const systemClock: Clock = {
    now: () => new Date(),
};

export const fixedClock = (at: Date | string | number): Clock => {
    const frozen = new Date(at);
    return { now: () => new Date(frozen.getTime()) };
};
