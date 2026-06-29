export const formatRupees = (value, { fractionDigits = 2 } = {}) =>
    value == null
        ? "—"
        : new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: fractionDigits,
        }).format(value);

export const formatPaise = (paise, opts) => formatRupees(paise == null ? null : paise / 100, opts);

export const formatNumber = (value, { fractionDigits = 2 } = {}) =>
    value == null
        ? "—"
        : new Intl.NumberFormat("en-IN", {
            maximumFractionDigits: fractionDigits,
            minimumFractionDigits: fractionDigits,
        }).format(value);
