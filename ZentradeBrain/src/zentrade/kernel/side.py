"""Order side. Kernel-level because both the Core and the research plane need it."""

from __future__ import annotations

from enum import Enum


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1
