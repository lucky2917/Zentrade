"""Contracts crossing the data-adapter boundary. Validated, never trusted raw."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DailyBar(BaseModel):
    """One normalised end-of-session equity bar. Prices are integer minor units."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    symbol: str = Field(min_length=1, max_length=32)
    isin: str = Field(min_length=12, max_length=12)
    series: str = Field(min_length=1, max_length=4)
    session_date: date
    open: int = Field(ge=0)
    high: int = Field(ge=0)
    low: int = Field(ge=0)
    close: int = Field(ge=0)
    volume: int = Field(ge=0)

    @field_validator("symbol", "series", "isin")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()

    def model_post_init(self, _context) -> None:
        if self.high < self.low:
            raise ValueError(f"{self.symbol} {self.session_date}: high {self.high} < low {self.low}")
        for name in ("open", "close"):
            price = getattr(self, name)
            if not (self.low <= price <= self.high):
                raise ValueError(
                    f"{self.symbol} {self.session_date}: {name} {price} outside [{self.low},{self.high}]"
                )
