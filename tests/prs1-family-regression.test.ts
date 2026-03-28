import assert from "node:assert/strict";
import test from "node:test";

import { rankParserFamilies } from "../lib/parsers/families";
import { shouldIgnorePathEarly } from "../lib/source-files";

test("DreamStation-style P-SERIES structure ranks Philips PRS1 ahead of BMC/Luna", () => {
  const files = [
    { normalizedPath: "P-SERIES/LAST.TXT" },
    { normalizedPath: "P-SERIES/74FAE00C/PROP.BIN" },
    { normalizedPath: "P-SERIES/74FAE00C/LOG.SEQ" },
    { normalizedPath: "P-SERIES/74FAE00C/D/000.003" },
    { normalizedPath: "P-SERIES/74FAE00C/E/000.004" }
  ];

  const ranked = rankParserFamilies(files);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]?.id, "prs1");
});

test("known OS metadata paths are ignored before SD-card parsing", () => {
  assert.equal(shouldIgnorePathEarly(".Spotlight-V100/Store-V2/file"), true);
  assert.equal(shouldIgnorePathEarly(".fseventsd/0000000004261b45"), true);
  assert.equal(shouldIgnorePathEarly("System Volume Information/WPSettings.dat"), true);
  assert.equal(shouldIgnorePathEarly("P-SERIES/74FAE00C/PROP.BIN"), false);
});
