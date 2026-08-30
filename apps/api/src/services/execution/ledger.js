// The one money model.
//
// Two existed. The legacy trading engine is margin-based: an INTRADAY buy
// debits margin, records it on the portfolio row, and the sell credits that
// margin back plus realised P&L. The execution engine debited the full gross
// and recorded no margin, so a position opened by one and closed by the other
// destroyed its own principal.
//
// These are the canonical arithmetic. Every path that moves cash uses them, so
// the model cannot diverge again. Pure functions: no I/O, no clock.

export const BROKERAGE_PAISE = 2000;
export const BUY_SPREAD = 1.001;
export const SELL_SPREAD = 0.999;
export const INTRADAY_LEVERAGE = 5;

export const isIntraday = (mode) => mode === "INTRADAY";

// Margin a buy consumes: leveraged for INTRADAY, the whole notional otherwise.
// This is what gets recorded against the position, because it is what the exit
// releases. Brokerage is a cost, not margin, so it is not recorded here and is
// not returned on the way out.
export const buyMarginPaise = ({ quantity, pricePaise, mode }) => {
    const gross = pricePaise * quantity;
    return isIntraday(mode) ? Math.ceil(gross / INTRADAY_LEVERAGE) : gross;
};

// Cash leaving the account on a buy. Brokerage is charged once per order, not
// once per fill.
export const buyDebitPaise = ({ quantity, pricePaise, mode, chargeBrokerage = true }) =>
    buyMarginPaise({ quantity, pricePaise, mode }) + (chargeBrokerage ? BROKERAGE_PAISE : 0);

// What a reservation must cover before the fill price is known. It prices the
// spread the buyer will pay, so it can only ever exceed the eventual debit.
export const buyObligationPaise = ({ quantity, pricePaise, mode }) =>
    buyDebitPaise({ quantity, pricePaise: Math.ceil(pricePaise * BUY_SPREAD), mode });

// Margin attributable to part of a holding, apportioned by quantity.
export const marginForQuantity = ({ quantity, heldQuantity, marginUsedPaise }) => {
    if (!heldQuantity || heldQuantity <= 0) return 0;
    if (quantity >= heldQuantity) return marginUsedPaise;
    return Math.round((quantity / heldQuantity) * marginUsedPaise);
};

export const realisedPnlPaise = ({ quantity, avgPricePaise, pricePaise }) =>
    (pricePaise - avgPricePaise) * quantity;

// Cash returned by a sell. INTRADAY releases the margin the units consumed
// plus their realised P&L; DELIVERY returns the proceeds.
export const sellCreditPaise = ({
    quantity, heldQuantity, marginUsedPaise, avgPricePaise, pricePaise, mode,
    chargeBrokerage = true,
}) => {
    const brokerage = chargeBrokerage ? BROKERAGE_PAISE : 0;
    if (!isIntraday(mode)) return pricePaise * quantity - brokerage;
    const released = marginForQuantity({ quantity, heldQuantity, marginUsedPaise });
    return released + realisedPnlPaise({ quantity, avgPricePaise, pricePaise }) - brokerage;
};

// Margin left on the row after selling part of it. Derived the same way the
// credit is, so the two can never disagree and leak margin.
export const remainingMarginPaise = ({ quantity, heldQuantity, marginUsedPaise }) => {
    if (quantity >= heldQuantity) return 0;
    return Math.round(((heldQuantity - quantity) / heldQuantity) * marginUsedPaise);
};
