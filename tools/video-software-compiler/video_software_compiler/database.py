from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from video_software_compiler.models import (
    EvidenceStatement,
    ExecutableRule,
    KnowledgeRecord,
    RequirementTrace,
)

SCHEMA_VERSION = 1

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_info (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    source_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    source_url TEXT,
    media_type TEXT NOT NULL DEFAULT 'video',
    caption TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    local_path TEXT,
    availability TEXT NOT NULL DEFAULT 'available',
    in_scope INTEGER NOT NULL DEFAULT 1,
    UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS stage_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    UNIQUE(stage, item_id, version)
);

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    source_url TEXT,
    published_at TEXT,
    timestamp_start REAL NOT NULL,
    timestamp_end REAL NOT NULL,
    evidence_type TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
    FOREIGN KEY(video_id) REFERENCES sources(source_id)
);

CREATE TABLE IF NOT EXISTS knowledge (
    knowledge_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    attribution TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
    record_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
    knowledge_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(knowledge_id, evidence_id),
    FOREIGN KEY(knowledge_id) REFERENCES knowledge(knowledge_id),
    FOREIGN KEY(evidence_id) REFERENCES evidence(evidence_id)
);

CREATE TABLE IF NOT EXISTS rules (
    rule_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    rule_json TEXT NOT NULL,
    PRIMARY KEY(rule_id, version)
);

CREATE TABLE IF NOT EXISTS rule_evidence (
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY(rule_id, rule_version, evidence_id),
    FOREIGN KEY(rule_id, rule_version) REFERENCES rules(rule_id, version),
    FOREIGN KEY(evidence_id) REFERENCES evidence(evidence_id)
);

CREATE TABLE IF NOT EXISTS requirements (
    requirement_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    trace_json TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    document_id UNINDEXED,
    kind UNINDEXED,
    title,
    content,
    tokenize='unicode61'
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


class StateDatabase:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            source_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(sources)").fetchall()
            }
            if "in_scope" not in source_columns:
                connection.execute(
                    "ALTER TABLE sources ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1"
                )
            row = connection.execute("SELECT version FROM schema_info LIMIT 1").fetchone()
            if row is None:
                connection.execute("INSERT INTO schema_info(version) VALUES (?)", (SCHEMA_VERSION,))
            elif row["version"] != SCHEMA_VERSION:
                raise RuntimeError(
                    f"Unsupported database schema {row['version']}; expected {SCHEMA_VERSION}"
                )

    def upsert_source(self, record: dict[str, Any]) -> bool:
        """Insert/update a source, returning True only for a newly discovered source."""
        with self.connect() as connection:
            existed = connection.execute(
                "SELECT 1 FROM sources WHERE provider=? AND external_id=?",
                (record["provider"], record["external_id"]),
            ).fetchone()
            connection.execute(
                """
                INSERT INTO sources (
                    source_id, provider, external_id, source_url, media_type, caption,
                    published_at, retrieved_at, metadata_json, content_hash, local_path,
                    availability
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, external_id) DO UPDATE SET
                    source_url=excluded.source_url,
                    media_type=excluded.media_type,
                    caption=excluded.caption,
                    published_at=COALESCE(excluded.published_at, sources.published_at),
                    retrieved_at=excluded.retrieved_at,
                    metadata_json=excluded.metadata_json,
                    content_hash=COALESCE(excluded.content_hash, sources.content_hash),
                    local_path=COALESCE(excluded.local_path, sources.local_path),
                    availability=excluded.availability
                """,
                (
                    record["source_id"],
                    record["provider"],
                    record["external_id"],
                    record.get("source_url"),
                    record.get("media_type", "video"),
                    record.get("caption", ""),
                    record.get("published_at"),
                    record.get("retrieved_at", _now()),
                    json.dumps(record.get("metadata", {}), sort_keys=True),
                    record.get("content_hash"),
                    record.get("local_path"),
                    record.get("availability", "available"),
                ),
            )
            self._index(
                connection,
                record["source_id"],
                "source",
                record.get("external_id", ""),
                record.get("caption", ""),
            )
        return existed is None

    @staticmethod
    def _index(
        connection: sqlite3.Connection, document_id: str, kind: str, title: str, content: str
    ) -> None:
        connection.execute(
            "DELETE FROM search_index WHERE document_id=? AND kind=?", (document_id, kind)
        )
        connection.execute(
            "INSERT INTO search_index(document_id, kind, title, content) VALUES (?, ?, ?, ?)",
            (document_id, kind, title, content),
        )

    def search(self, query: str, limit: int = 25) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT document_id, kind, title,
                       snippet(search_index, 3, '[', ']', ' … ', 18) AS snippet,
                       bm25(search_index) AS score
                FROM search_index WHERE search_index MATCH ?
                ORDER BY score LIMIT ?
                """,
                (query, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def save_evidence(self, statement: EvidenceStatement) -> None:
        with self.connect() as connection:
            data = statement.model_dump(mode="json")
            connection.execute(
                """
                INSERT INTO evidence (
                    evidence_id, video_id, source_url, published_at, timestamp_start,
                    timestamp_end, evidence_type, content, confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(evidence_id) DO UPDATE SET
                    timestamp_start=excluded.timestamp_start,
                    timestamp_end=excluded.timestamp_end,
                    evidence_type=excluded.evidence_type,
                    content=excluded.content,
                    confidence=excluded.confidence
                """,
                (
                    data["evidence_id"],
                    data["video_id"],
                    data["source_url"],
                    data["published_at"],
                    data["timestamp_start"],
                    data["timestamp_end"],
                    data["evidence_type"],
                    data["content"],
                    data["confidence"],
                ),
            )
            self._index(
                connection,
                statement.evidence_id,
                "evidence",
                f"{statement.video_id} @ {statement.timestamp_start:.3f}",
                statement.content,
            )

    def save_knowledge(self, record: KnowledgeRecord) -> None:
        data = record.model_dump(mode="json")
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO knowledge (
                    knowledge_id, type, title, description, attribution, status,
                    confidence, record_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(knowledge_id) DO UPDATE SET
                    type=excluded.type, title=excluded.title, description=excluded.description,
                    attribution=excluded.attribution, status=excluded.status,
                    confidence=excluded.confidence, record_json=excluded.record_json
                """,
                (
                    record.knowledge_id,
                    record.type,
                    record.title,
                    record.description,
                    record.attribution,
                    record.status,
                    record.confidence,
                    json.dumps(data, sort_keys=True),
                ),
            )
            connection.execute(
                "DELETE FROM knowledge_evidence WHERE knowledge_id=?", (record.knowledge_id,)
            )
            connection.executemany(
                "INSERT INTO knowledge_evidence(knowledge_id, evidence_id) VALUES (?, ?)",
                [(record.knowledge_id, item.evidence_id) for item in record.evidence],
            )
            self._index(
                connection,
                record.knowledge_id,
                "knowledge",
                record.title,
                record.description,
            )

    def save_rule(self, rule: ExecutableRule) -> None:
        data = rule.model_dump(mode="json")
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO rules(rule_id, version, name, source, rule_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(rule_id, version) DO UPDATE SET
                    name=excluded.name, source=excluded.source, rule_json=excluded.rule_json
                """,
                (
                    rule.rule_id,
                    rule.version,
                    rule.name,
                    rule.source,
                    json.dumps(data, sort_keys=True),
                ),
            )
            connection.execute(
                "DELETE FROM rule_evidence WHERE rule_id=? AND rule_version=?",
                (rule.rule_id, rule.version),
            )
            connection.executemany(
                "INSERT INTO rule_evidence(rule_id, rule_version, evidence_id) VALUES (?, ?, ?)",
                [(rule.rule_id, rule.version, evidence_id) for evidence_id in rule.evidence_ids],
            )
            self._index(
                connection,
                f"{rule.rule_id}@{rule.version}",
                "rule",
                rule.name,
                json.dumps(data, sort_keys=True),
            )

    def save_requirement(self, requirement: RequirementTrace) -> None:
        data = requirement.model_dump(mode="json")
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO requirements(requirement_id, title, origin, trace_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(requirement_id) DO UPDATE SET
                    title=excluded.title, origin=excluded.origin, trace_json=excluded.trace_json
                """,
                (
                    requirement.requirement_id,
                    requirement.title,
                    requirement.origin,
                    json.dumps(data, sort_keys=True),
                ),
            )
            self._index(
                connection,
                requirement.requirement_id,
                "requirement",
                requirement.title,
                json.dumps(data, sort_keys=True),
            )

    def start_stage(self, stage: str, item_id: str, version: int = 1) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO stage_runs(stage, item_id, version, status, attempts, started_at)
                VALUES (?, ?, ?, 'in_progress', 1, ?)
                ON CONFLICT(stage, item_id, version) DO UPDATE SET
                    status='in_progress', attempts=attempts+1, started_at=excluded.started_at,
                    finished_at=NULL, error=NULL
                """,
                (stage, item_id, version, _now()),
            )

    def finish_stage(
        self, stage: str, item_id: str, status: str = "complete", error: str | None = None
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """UPDATE stage_runs SET status=?, finished_at=?, error=?
                   WHERE stage=? AND item_id=?""",
                (status, _now(), error, stage, item_id),
            )

    def recover_stale(self, stale_after: timedelta = timedelta(hours=1)) -> int:
        cutoff = (datetime.now(UTC) - stale_after).isoformat()
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE stage_runs SET status='retryable_failure',
                    error='Recovered stale in_progress state', finished_at=?
                WHERE status='in_progress' AND started_at < ?
                """,
                (_now(), cutoff),
            )
            return cursor.rowcount

    def counts(self) -> dict[str, int]:
        tables = ("sources", "evidence", "knowledge", "rules", "requirements")
        with self.connect() as connection:
            return {
                table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in tables
            }

    def set_latest_source_scope(self, provider: str, limit: int | None) -> dict[str, int]:
        with self.connect() as connection:
            connection.execute("UPDATE sources SET in_scope=0 WHERE provider=?", (provider,))
            if limit is None:
                connection.execute(
                    """
                    UPDATE sources SET in_scope=1
                    WHERE provider=? AND media_type IN ('video', 'carousel_video')
                    """,
                    (provider,),
                )
            else:
                selected = connection.execute(
                    """
                    SELECT source_id FROM sources
                    WHERE provider=? AND media_type IN ('video', 'carousel_video')
                    ORDER BY published_at DESC, source_id DESC LIMIT ?
                    """,
                    (provider, limit),
                ).fetchall()
                connection.executemany(
                    "UPDATE sources SET in_scope=1 WHERE source_id=?",
                    [(row["source_id"],) for row in selected],
                )
            active = connection.execute(
                "SELECT COUNT(*) FROM sources WHERE provider=? AND in_scope=1", (provider,)
            ).fetchone()[0]
            excluded = connection.execute(
                "SELECT COUNT(*) FROM sources WHERE provider=? AND in_scope=0", (provider,)
            ).fetchone()[0]
        return {"in_scope": active, "out_of_scope": excluded}

    def set_latest_instagram_scope(self, limit: int | None) -> dict[str, int]:
        """Select the newest Instagram videos across current and future local providers."""
        providers = ("instaloader", "gallery-dl")
        placeholders = ",".join("?" for _ in providers)
        with self.connect() as connection:
            connection.execute(
                f"UPDATE sources SET in_scope=0 WHERE provider IN ({placeholders})", providers
            )
            query = f"""
                SELECT source_id FROM sources
                WHERE provider IN ({placeholders})
                  AND media_type IN ('video', 'carousel_video')
                  AND availability='available'
                  AND local_path IS NOT NULL
                ORDER BY published_at DESC, source_id DESC
            """
            params: tuple[Any, ...] = providers
            if limit is not None:
                query += " LIMIT ?"
                params = (*providers, limit)
            selected = connection.execute(query, params).fetchall()
            connection.executemany(
                "UPDATE sources SET in_scope=1 WHERE source_id=?",
                [(row["source_id"],) for row in selected],
            )
            active = connection.execute(
                f"SELECT COUNT(*) FROM sources WHERE provider IN ({placeholders}) AND in_scope=1",
                providers,
            ).fetchone()[0]
            excluded = connection.execute(
                f"SELECT COUNT(*) FROM sources WHERE provider IN ({placeholders}) AND in_scope=0",
                providers,
            ).fetchone()[0]
        return {"in_scope": active, "out_of_scope": excluded}

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM sources WHERE source_id=?", (source_id,)
            ).fetchone()
        return dict(row) if row else None
