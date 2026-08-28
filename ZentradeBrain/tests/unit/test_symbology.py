"""
Entity resolution. Cases derived from real NSE data across 449+ sessions,
where 219 ISINs appeared under several symbols and 279 symbols under several
ISINs. Neither identifier is stable, so the entity is the connected component.
"""
from datetime import date

from zentrade.adapters.data.symbology import Observation, build

D1, D2, D3 = date(2021, 6, 1), date(2022, 6, 1), date(2023, 6, 1)


def obs(pairs):
    return [Observation(s, i, d) for s, i, d in pairs]


class TestRenames:
    def test_one_isin_two_symbols_is_one_entity(self):
        """CADILAHC -> ZYDUSLIFE, the real 2022 rename."""
        sg = build(obs([("CADILAHC", "INE010B01027", D1), ("ZYDUSLIFE", "INE010B01027", D2)]))
        assert len(sg.entities) == 1
        entity = sg.entity_for_symbol("ZYDUSLIFE")
        assert entity.symbols == frozenset({"CADILAHC", "ZYDUSLIFE"})
        assert entity.renamed and not entity.reissued
        assert sg.entity_for_symbol("CADILAHC").entity_id == entity.entity_id

    def test_history_spans_the_rename(self):
        sg = build(obs([("CADILAHC", "INE010B01027", D1), ("ZYDUSLIFE", "INE010B01027", D3)]))
        entity = sg.entity_for_symbol("CADILAHC")
        assert (entity.first_seen, entity.last_seen) == (D1, D3)

    def test_aliases_round_trip_both_directions(self):
        sg = build(obs([("CADILAHC", "INE010B01027", D1), ("ZYDUSLIFE", "INE010B01027", D2)]))
        assert sg.aliases_of("CADILAHC") == sg.aliases_of("ZYDUSLIFE")


class TestIsinReassignment:
    def test_one_symbol_two_isins_is_one_entity(self):
        """ADANIPOWER carried two ISINs; a face-value change reissues the ISIN."""
        sg = build(obs([("ADANIPOWER", "INE814H01011", D1), ("ADANIPOWER", "INE814H01029", D2)]))
        assert len(sg.entities) == 1
        entity = sg.entity_for_symbol("ADANIPOWER")
        assert entity.reissued and not entity.renamed
        assert sg.entity_for_isin("INE814H01011") is sg.entity_for_isin("INE814H01029")

    def test_a_chain_of_both_changes_stays_one_entity(self):
        sg = build(obs([
            ("OLDCO", "INE111A01011", D1),
            ("NEWCO", "INE111A01011", D2),   # rename
            ("NEWCO", "INE111A01029", D3),   # then ISIN reissue
        ]))
        assert len(sg.entities) == 1
        entity = sg.entity_for_symbol("OLDCO")
        assert entity.symbols == frozenset({"OLDCO", "NEWCO"})
        assert entity.isins == frozenset({"INE111A01011", "INE111A01029"})


class TestIdentity:
    def test_unrelated_companies_stay_separate(self):
        sg = build(obs([("RELIANCE", "INE002A01018", D1), ("TCS", "INE467B01029", D1)]))
        assert len(sg.entities) == 2

    def test_entity_id_is_insertion_order_independent(self):
        pairs = [("A", "INE111A01011", D1), ("B", "INE111A01011", D2), ("B", "INE222A01011", D3)]
        forward = build(obs(pairs)).entity_for_symbol("A").entity_id
        backward = build(obs(list(reversed(pairs)))).entity_for_symbol("A").entity_id
        assert forward == backward, "entity ids must be reproducible across runs"

    def test_entity_id_is_the_smallest_isin(self):
        sg = build(obs([("X", "INE999Z01011", D1), ("X", "INE111A01011", D2)]))
        assert sg.entity_for_symbol("X").entity_id == "INE111A01011"

    def test_unknown_symbol_resolves_to_itself(self):
        sg = build(obs([("RELIANCE", "INE002A01018", D1)]))
        assert sg.entity_for_symbol("NOSUCH") is None
        assert sg.aliases_of("NOSUCH") == frozenset({"NOSUCH"})
