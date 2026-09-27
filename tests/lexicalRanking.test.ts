import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { lexicalScoreMap, type LexicalHit } from "../src/server/recommendation/lexicalRanking";

describe("FTS5 lexical score ordering", () => {
  it("does not invert the reproduced strong and weak BM25 matches", () => {
    const scores = lexicalScoreMap([
      { mediaItemId: "strong", rank: -7.325 },
      { mediaItemId: "weak", rank: -2.274 }
    ]);
    expect(scores.get("strong")).toBe(100);
    expect(scores.get("weak")).toBe(99);
  });

  it.each([1e-12, 1, 1e12])("is invariant to positive BM25 rescaling by %s", (scale) => {
    const hits = [{ mediaItemId: "a", rank: -8 }, { mediaItemId: "b", rank: -2 }, { mediaItemId: "c", rank: -0.01 }];
    expect(lexicalScoreMap(hits.map((hit) => ({ ...hit, rank: hit.rank * scale })))).toEqual(lexicalScoreMap(hits));
  });

  it("gives tied evidence equal scores and does not use IDs as evidence", () => {
    const scores = lexicalScoreMap([
      { mediaItemId: "z", rank: -4 }, { mediaItemId: "a", rank: -4 }, { mediaItemId: "b", rank: -1 }
    ]);
    expect(scores.get("z")).toBe(scores.get("a"));
    expect(scores.get("b")).toBe(98);
  });

  it("deduplicates by the best BM25 without counting duplicate hits", () => {
    const distinct = [{ mediaItemId: "a", rank: -4 }, { mediaItemId: "b", rank: -1 }];
    expect(lexicalScoreMap([...distinct, { mediaItemId: "a", rank: -2 }, ...distinct])).toEqual(lexicalScoreMap(distinct));
  });

  it("ignores non-finite evidence rather than assigning fabricated match scores", () => {
    expect(lexicalScoreMap([
      { mediaItemId: "nan", rank: NaN }, { mediaItemId: "negative-infinity", rank: -Infinity },
      { mediaItemId: "infinity", rank: Infinity }, { mediaItemId: "valid", rank: -1 }
    ])).toEqual(new Map([["valid", 100]]));
  });

  it("does not mutate the input and is independent of input ordering", () => {
    const hits = Object.freeze([
      Object.freeze({ mediaItemId: "weak", rank: -1 }), Object.freeze({ mediaItemId: "strong", rank: -2 })
    ]);
    expect(lexicalScoreMap(hits)).toEqual(lexicalScoreMap([...hits].reverse()));
    expect(hits[0].mediaItemId).toBe("weak");
  });

  it("retains the established positional budget without claiming probability calibration", () => {
    const hits = Array.from({ length: 180 }, (_, index) => ({ mediaItemId: String(index), rank: index - 180 }));
    const scores = [...lexicalScoreMap(hits).values()];
    expect(scores[0]).toBe(100);
    expect(scores.at(-1)).toBe(65);
    expect(scores.every((score, index) => Number.isFinite(score) && (index === 0 || score <= scores[index - 1]))).toBe(true);
  });

  it("handles an empty list", () => {
    expect(lexicalScoreMap([]).size).toBe(0);
  });

  it.each(["rare", "common"])("preserves actual SQLite BM25 ordering for a %s term", (query) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE documents USING fts5(mediaItemId UNINDEXED, content)");
      const insert = db.prepare("INSERT INTO documents VALUES (?, ?)");
      insert.run("strong", "rare rare rare common common common");
      insert.run("weak", `rare common ${"unrelated ".repeat(80)}`);
      for (let index = 0; index < 100; index += 1) insert.run(`other-${index}`, "common ordinary catalogue description");
      const hits = db.prepare("SELECT mediaItemId, bm25(documents) AS rank FROM documents WHERE documents MATCH ? ORDER BY rank, mediaItemId")
        .all(query) as unknown as LexicalHit[];
      const scores = lexicalScoreMap(hits);
      expect(hits.length).toBeGreaterThan(1);
      for (let index = 1; index < hits.length; index += 1) {
        expect(scores.get(hits[index - 1].mediaItemId)!).toBeGreaterThanOrEqual(scores.get(hits[index].mediaItemId)!);
      }
      expect(scores.get("strong")!).toBeGreaterThan(scores.get("weak")!);
    } finally {
      db.close();
    }
  });
});
