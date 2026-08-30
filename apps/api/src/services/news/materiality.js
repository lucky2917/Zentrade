// Deterministic materiality classification.
//
// Runs BEFORE any LLM. The point is to decide what deserves expensive
// reasoning using only source metadata, so a routine filing cannot buy a
// reasoning call and a results announcement cannot be missed.
//
// Rules are keyword-based over the announcement subject, which is the field
// NSE actually populates. That is a deliberate limitation, stated rather than
// dressed up: it classifies what the source tells us and nothing more.

export const MATERIALITY = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", CRITICAL: "CRITICAL" };

export const EVENT_CATEGORY = {
    EARNINGS: "EARNINGS",
    CORPORATE_ACTION: "CORPORATE_ACTION",
    REGULATORY: "REGULATORY",
    MATERIAL_COMPANY_EVENT: "MATERIAL_COMPANY_EVENT",
    ROUTINE_DISCLOSURE: "ROUTINE_DISCLOSURE",
    MARKET_WIDE: "MARKET_WIDE",
    UNKNOWN: "UNKNOWN",
};

// Ordered: the first matching rule wins, most consequential first.
export const CLASSIFICATION_RULES = [
    { category: EVENT_CATEGORY.EARNINGS, materiality: MATERIALITY.HIGH,
      patterns: [/financial result/i, /quarterly result/i, /audited result/i,
                 /unaudited result/i, /earnings/i] },
    { category: EVENT_CATEGORY.CORPORATE_ACTION, materiality: MATERIALITY.HIGH,
      patterns: [/\bbonus\b/i, /stock split/i, /\bsplit\b/i, /consolidation of shares/i,
                 /\brights issue\b/i, /\bbuyback\b/i, /\bdividend\b/i] },
    { category: EVENT_CATEGORY.MATERIAL_COMPANY_EVENT, materiality: MATERIALITY.CRITICAL,
      patterns: [/\bmerger\b/i, /\bacquisition\b/i, /\bamalgamation\b/i, /\bdemerger\b/i,
                 /\binsolvency\b/i, /\bresolution plan\b/i, /\bdefault\b/i,
                 /\bfraud\b/i, /\bresignation of\b.*\b(ceo|managing director|cfo)\b/i] },
    { category: EVENT_CATEGORY.REGULATORY, materiality: MATERIALITY.HIGH,
      patterns: [/\bsebi\b/i, /\bpenalty\b/i, /show cause/i, /\bsuspension\b/i,
                 /\bdelisting\b/i, /\binvestigation\b/i] },
    { category: EVENT_CATEGORY.MATERIAL_COMPANY_EVENT, materiality: MATERIALITY.MEDIUM,
      patterns: [/\border win\b/i, /\bcontract\b/i, /\bcapacity expansion\b/i,
                 /\bfund rais/i, /\bpreferential issue\b/i, /credit rating/i] },
    { category: EVENT_CATEGORY.ROUTINE_DISCLOSURE, materiality: MATERIALITY.LOW,
      patterns: [/newspaper publication/i, /trading window/i, /investor presentation/i,
                 /analyst meet/i, /schedule of/i, /intimation of/i, /compliance certificate/i,
                 /shareholding pattern/i, /disclosure under regulation/i] },
];

export const classify = (announcement) => {
    const subject = `${announcement.subject ?? ""} ${announcement.headline ?? ""}`.trim();

    if (!subject) {
        // No subject means no basis for judgement. Recorded as unknown and
        // traceable rather than guessed at.
        return {
            category: EVENT_CATEGORY.UNKNOWN, materiality: MATERIALITY.LOW,
            matchedRule: null,
            rationale: "no subject text supplied by the source; not classifiable",
        };
    }

    for (const rule of CLASSIFICATION_RULES) {
        const hit = rule.patterns.find((p) => p.test(subject));
        if (hit) {
            return {
                category: rule.category, materiality: rule.materiality,
                matchedRule: hit.source,
                rationale: `subject matched ${hit.source} for ${rule.category}`,
            };
        }
    }

    // Unmatched is genuinely unknown, not routine. Treating everything
    // unrecognised as unimportant is how a real event gets missed.
    return {
        category: EVENT_CATEGORY.UNKNOWN, materiality: MATERIALITY.MEDIUM,
        matchedRule: null,
        rationale: "no classification rule matched; unknown rather than routine",
    };
};

// Only these wake the expensive path. LOW is recorded for the audit trail.
export const REASONING_MATERIALITY = new Set([MATERIALITY.HIGH, MATERIALITY.CRITICAL]);

export const warrantsReasoning = (materiality) => REASONING_MATERIALITY.has(materiality);
