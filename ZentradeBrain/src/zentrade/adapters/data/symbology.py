"""Entity resolution across symbol and ISIN changes."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date


@dataclass
class Observation:
    symbol: str
    isin: str
    session_date: date


@dataclass
class Entity:
    entity_id: str
    isins: frozenset[str]
    symbols: frozenset[str]
    first_seen: date
    last_seen: date

    @property
    def renamed(self) -> bool:
        return len(self.symbols) > 1

    @property
    def reissued(self) -> bool:
        return len(self.isins) > 1


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != root:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


@dataclass
class Symbology:
    entities: dict[str, Entity] = field(default_factory=dict)
    by_symbol: dict[str, str] = field(default_factory=dict)
    by_isin: dict[str, str] = field(default_factory=dict)

    def entity_for_symbol(self, symbol: str) -> Entity | None:
        eid = self.by_symbol.get(symbol.upper())
        return self.entities.get(eid) if eid else None

    def entity_for_isin(self, isin: str) -> Entity | None:
        eid = self.by_isin.get(isin.upper())
        return self.entities.get(eid) if eid else None

    def aliases_of(self, symbol: str) -> frozenset[str]:
        entity = self.entity_for_symbol(symbol)
        return entity.symbols if entity else frozenset({symbol.upper()})


def build(observations: list[Observation]) -> Symbology:
    """Connected components over symbol<->ISIN edges. Prefixes keep the two."""
    uf = UnionFind()
    for obs in observations:
        uf.union(f"S:{obs.symbol.upper()}", f"I:{obs.isin.upper()}")

    members: dict[str, set[str]] = defaultdict(set)
    dates: dict[str, list[date]] = defaultdict(list)
    for obs in observations:
        root = uf.find(f"S:{obs.symbol.upper()}")
        members[root].update({f"S:{obs.symbol.upper()}", f"I:{obs.isin.upper()}"})
        dates[root].append(obs.session_date)

    symbology = Symbology()
    for root, nodes in members.items():
        isins = frozenset(n[2:] for n in nodes if n.startswith("I:"))
        symbols = frozenset(n[2:] for n in nodes if n.startswith("S:"))
        entity_id = min(isins) if isins else min(symbols)
        seen = dates[root]
        entity = Entity(entity_id, isins, symbols, min(seen), max(seen))
        symbology.entities[entity_id] = entity
        for s in symbols:
            symbology.by_symbol[s] = entity_id
        for i in isins:
            symbology.by_isin[i] = entity_id
    return symbology
