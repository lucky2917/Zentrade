-- M17: the Knowledge Store — the Brain's immutable external-observation corpus.
-- A document is an ingested source; chunks are deterministic slices of its
-- normalized text, addressed by character offsets and hashes (never a stored
-- copy of the text). Identity is content plus provenance, independent of any
-- embedding model or vector store. knowledge_semantics is stamped per document
-- so a future normalization or chunking (knowledge_v2, ...) coexists and never
-- reinterprets prior rows. Append-only like every observation the Brain keeps.
--
-- License is an ALLOWLIST enforced in the database: a document under an
-- unpermitted license cannot physically exist here. The list is additive only.
-- Nothing on the decision path reads these tables (measurement before adaptation).

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_key CHAR(64) NOT NULL UNIQUE,
  knowledge_semantics VARCHAR(32) NOT NULL,
  source_uri TEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL,
  publisher VARCHAR(256),
  license VARCHAR(48) NOT NULL CHECK (license IN
    ('public-domain', 'operator-owned', 'cc-by-4.0', 'cc-by-sa-4.0', 'licensed-redistributable')),
  content_type VARCHAR(64) NOT NULL,
  normalized_text TEXT NOT NULL,
  char_len INTEGER NOT NULL CHECK (char_len >= 0),
  byte_len INTEGER NOT NULL CHECK (byte_len >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  instrument_id UUID REFERENCES instruments(id),
  published_at DATE,
  retrieved_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_key CHAR(64) NOT NULL UNIQUE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  char_start INTEGER NOT NULL CHECK (char_start >= 0),
  char_end INTEGER NOT NULL CHECK (char_end >= char_start),
  text_sha256 CHAR(64) NOT NULL,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks (document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_instrument ON knowledge_documents (instrument_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_ingested ON knowledge_documents (ingested_at DESC);

DO $$ BEGIN
  CREATE TRIGGER knowledge_documents_append_only
    BEFORE UPDATE OR DELETE ON knowledge_documents
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER knowledge_documents_no_truncate
    BEFORE TRUNCATE ON knowledge_documents
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER knowledge_chunks_append_only
    BEFORE UPDATE OR DELETE ON knowledge_chunks
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER knowledge_chunks_no_truncate
    BEFORE TRUNCATE ON knowledge_chunks
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
