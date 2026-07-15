export const exponentialDecay = (ageDays: number, halfLifeDays: number): number => {
    if (!Number.isFinite(ageDays) || ageDays < 0) throw new Error(`invalid ageDays: ${ageDays}`);
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new Error(`invalid halfLifeDays: ${halfLifeDays}`);
    return Math.pow(0.5, ageDays / halfLifeDays);
};
