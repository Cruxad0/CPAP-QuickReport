import assert from "node:assert/strict";
import test from "node:test";

import { savePdfArtifact } from "../lib/pdf-save";

test("the save picker writes the PDF to the user-selected file", async () => {
  const blob = new Blob(["report"], { type: "application/pdf" });
  let pickerOptions: unknown;
  let writtenBlob: Blob | undefined;
  let closeCount = 0;
  const browserWindow = {
    showSaveFilePicker: async (options: unknown) => {
      pickerOptions = options;
      return {
        createWritable: async () => ({
          write: async (data: Blob) => {
            writtenBlob = data;
          },
          close: async () => {
            closeCount += 1;
          }
        })
      };
    }
  } as unknown as Window;

  const result = await savePdfArtifact(blob, "JR-20260828.pdf", "blob:preview", { browserWindow });

  assert.equal(result, "saved");
  assert.equal(writtenBlob, blob);
  assert.equal(closeCount, 1);
  assert.deepEqual(pickerOptions, {
    suggestedName: "JR-20260828.pdf",
    startIn: "downloads",
    id: "cpap-quickreport-pdf",
    types: [
      {
        description: "PDF document",
        accept: { "application/pdf": [".pdf"] }
      }
    ]
  });
});

test("cancelling the save picker does not create a fallback download", async () => {
  const cancellation = new Error("User cancelled");
  cancellation.name = "AbortError";
  const browserWindow = {
    showSaveFilePicker: async () => {
      throw cancellation;
    }
  } as unknown as Window;

  const result = await savePdfArtifact(new Blob(), "report.pdf", "blob:preview", { browserWindow });

  assert.equal(result, "cancelled");
});

test("browsers without a save picker receive a standard named download", async () => {
  const link = {
    href: "",
    download: "",
    clickCount: 0,
    removeCount: 0,
    click() {
      this.clickCount += 1;
    },
    remove() {
      this.removeCount += 1;
    }
  };
  let appendedNode: unknown;
  const browserDocument = {
    createElement: (tagName: string) => {
      assert.equal(tagName, "a");
      return link;
    },
    body: {
      appendChild: (node: unknown) => {
        appendedNode = node;
      }
    }
  } as unknown as Document;

  const result = await savePdfArtifact(new Blob(), "report.pdf", "blob:preview", {
    browserWindow: {} as Window,
    browserDocument
  });

  assert.equal(result, "downloaded");
  assert.equal(link.href, "blob:preview");
  assert.equal(link.download, "report.pdf");
  assert.equal(appendedNode, link);
  assert.equal(link.clickCount, 1);
  assert.equal(link.removeCount, 1);
});

test("save picker failures are reported without starting a duplicate download", async () => {
  const browserWindow = {
    showSaveFilePicker: async () => {
      throw new Error("File system access denied");
    }
  } as unknown as Window;

  await assert.rejects(
    savePdfArtifact(new Blob(), "report.pdf", "blob:preview", { browserWindow }),
    /File system access denied/
  );
});

test("a failed disk write aborts the file stream and reports the original error", async () => {
  const writeError = new Error("Disk is full");
  let abortReason: unknown;
  const browserWindow = {
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async () => {
          throw writeError;
        },
        close: async () => {
          throw new Error("close should not run");
        },
        abort: async (reason: unknown) => {
          abortReason = reason;
        }
      })
    })
  } as unknown as Window;

  await assert.rejects(
    savePdfArtifact(new Blob(), "report.pdf", "blob:preview", { browserWindow }),
    (error: unknown) => error === writeError
  );
  assert.equal(abortReason, writeError);
});
