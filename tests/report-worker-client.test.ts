import assert from "node:assert/strict";
import test from "node:test";

import { ReportWorkerClient } from "../lib/report-worker-client";

test("disposing the report worker rejects pending analysis and folder import requests", async () => {
  const originalWorker = globalThis.Worker;
  let terminated = false;

  class FakeWorker {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {
      terminated = true;
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: FakeWorker
  });

  try {
    const client = new ReportWorkerClient();
    const pendingImport = client.loadFolderEntries([], {
      importLookbackDays: 181,
      parseLookbackDays: 181
    });
    const pendingReset = client.reset();

    client.dispose();

    await assert.rejects(pendingImport, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await assert.rejects(pendingReset, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(terminated, true);
  } finally {
    if (originalWorker) {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: originalWorker
      });
    } else {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    }
  }
});
