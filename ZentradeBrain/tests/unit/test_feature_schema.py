"""Feature schema hashing and fail-closed loading."""
import pytest

from zentrade.features import schema as sch
from zentrade.features.schema import (
    FEATURE_NAMES, SchemaDescriptor, SchemaMismatch, require_schema, schema_hash,
)


class TestHash:
    def test_stable_across_calls(self):
        assert schema_hash() == schema_hash()

    def test_is_a_sha256_hex_digest(self):
        digest = schema_hash()
        assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)

    def test_feature_order_is_part_of_identity(self, monkeypatch):
        before = schema_hash()
        monkeypatch.setattr(sch, "FEATURE_NAMES", tuple(reversed(FEATURE_NAMES)))
        assert schema_hash() != before, "reordering features must change the hash"

    def test_renaming_a_feature_changes_the_hash(self, monkeypatch):
        before = schema_hash()
        monkeypatch.setattr(sch, "FEATURE_NAMES", ("renamed",) + FEATURE_NAMES[1:])
        assert schema_hash() != before

    def test_semantics_id_is_part_of_identity(self, monkeypatch):
        before = schema_hash()
        monkeypatch.setattr(sch, "FEATURE_SEMANTICS", "features_v2")
        assert schema_hash() != before


class TestFailClosed:
    def test_matching_hash_is_accepted(self):
        require_schema(schema_hash())

    def test_mismatched_hash_raises(self):
        with pytest.raises(SchemaMismatch):
            require_schema("0" * 64)

    def test_mismatch_names_both_sides(self):
        with pytest.raises(SchemaMismatch) as excinfo:
            require_schema("abc")
        assert excinfo.value.expected == "abc"
        assert excinfo.value.actual == schema_hash()

    def test_empty_hash_is_not_a_pass(self):
        """An artifact with no recorded schema must fail, never default to ok."""
        with pytest.raises(SchemaMismatch):
            require_schema("")


class TestDescriptor:
    def test_current_matches_module_state(self):
        descriptor = SchemaDescriptor.current()
        assert descriptor.features == FEATURE_NAMES
        assert descriptor.hash == schema_hash()

    def test_twelve_features_declared(self):
        assert len(FEATURE_NAMES) == 12
        assert len(set(FEATURE_NAMES)) == 12, "feature names must be unique"
