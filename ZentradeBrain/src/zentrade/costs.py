"""NSE equity transaction costs and the bootstrap slippage model.

Pure arithmetic with no state and no authority, so it sits outside core/.
The boundary rule exists to stop Research and Learning trading or mutating
state, not to stop them costing a trade they are only measuring.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

from .kernel.side import Side

CALIBRATION_STAGE = "bootstrap"

BASIS = 1_000_000


class ProductType(str, Enum):
    DELIVERY = "DELIVERY"
    INTRADAY = "INTRADAY"


@dataclass(frozen=True)
class CostSchedule:
    """Rates in millionths of turnover unless named otherwise."""

    brokerage_flat_paise: int = 2000
    brokerage_rate: int = 300
    brokerage_cap_paise: int = 2000
    stt_delivery: int = 1000
    stt_intraday_sell: int = 250
    exchange_txn: int = 30
    sebi_turnover: int = 1
    stamp_delivery_buy: int = 150
    stamp_intraday_buy: int = 30
    gst_rate: int = 180_000
    dp_charge_paise: int = 1593


@dataclass(frozen=True)
class SlippageModel:
    """Conservative bootstrap slippage."""

    half_spread_bps: float = 5.0
    impact_bps_at_full_participation: float = 100.0
    conservatism_multiplier: float = 1.5

    def slippage_bps(self, participation: float) -> float:
        if participation < 0:
            raise ValueError("participation cannot be negative")
        impact = self.impact_bps_at_full_participation * math.sqrt(min(participation, 1.0))
        return (self.half_spread_bps + impact) * self.conservatism_multiplier

    def adjusted_price(self, reference_price: int, side: Side, participation: float) -> int:
        bps = self.slippage_bps(participation)
        moved = reference_price * (1.0 + side.sign * bps / 10_000.0)
        return max(1, int(moved + 0.5))


@dataclass(frozen=True)
class CostBreakdown:
    brokerage: int
    stt: int
    exchange: int
    sebi: int
    stamp: int
    gst: int
    dp: int

    @property
    def total(self) -> int:
        return self.brokerage + self.stt + self.exchange + self.sebi + self.stamp + self.gst + self.dp

    def as_dict(self) -> dict[str, int]:
        return {"brokerage": self.brokerage, "stt": self.stt, "exchange": self.exchange,
                "sebi": self.sebi, "stamp": self.stamp, "gst": self.gst, "dp": self.dp,
                "total": self.total}


def _apply(turnover: int, rate: int) -> int:
    return (turnover * rate + BASIS - 1) // BASIS


def compute_costs(turnover: int, side: Side, product: ProductType,
                  schedule: CostSchedule | None = None) -> CostBreakdown:
    """Itemised charges on one executed order. Rounded up, never down."""
    if turnover < 0:
        raise ValueError("turnover cannot be negative")
    schedule = schedule or CostSchedule()

    brokerage = min(_apply(turnover, schedule.brokerage_rate), schedule.brokerage_cap_paise)

    if product is ProductType.DELIVERY:
        stt = _apply(turnover, schedule.stt_delivery)
        stamp = _apply(turnover, schedule.stamp_delivery_buy) if side is Side.BUY else 0
        dp = schedule.dp_charge_paise if side is Side.SELL else 0
    else:
        stt = _apply(turnover, schedule.stt_intraday_sell) if side is Side.SELL else 0
        stamp = _apply(turnover, schedule.stamp_intraday_buy) if side is Side.BUY else 0
        dp = 0

    exchange = _apply(turnover, schedule.exchange_txn)
    sebi = _apply(turnover, schedule.sebi_turnover)
    gst = _apply(brokerage + exchange + sebi, schedule.gst_rate)

    return CostBreakdown(brokerage=brokerage, stt=stt, exchange=exchange,
                         sebi=sebi, stamp=stamp, gst=gst, dp=dp)
