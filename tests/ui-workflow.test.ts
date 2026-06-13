import assert from "node:assert/strict";
import test from "node:test";

import { shouldClearPatientDetailsForSourceImport } from "../lib/ui-workflow";

test("the first source import preserves patient details entered while choosing the card", () => {
  assert.equal(
    shouldClearPatientDetailsForSourceImport({
      sourceFileCount: 0,
      loadedSourceLoader: null,
      hasGeneratedReports: false
    }),
    false
  );
});

test("a replacement source import clears patient details before loading the new card", () => {
  const replacementStates = [
    { sourceFileCount: 1, loadedSourceLoader: null, hasGeneratedReports: false },
    { sourceFileCount: 0, loadedSourceLoader: "ResMed", hasGeneratedReports: false },
    { sourceFileCount: 0, loadedSourceLoader: null, hasGeneratedReports: true }
  ];

  for (const state of replacementStates) {
    assert.equal(shouldClearPatientDetailsForSourceImport(state), true);
  }
});
