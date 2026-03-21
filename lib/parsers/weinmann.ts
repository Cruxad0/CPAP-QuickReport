import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserCandidate, FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { QuickReportMetrics } from "@/lib/types";

function inferWeinmannMachineSettings(
  text: string,
  candidate: FamilyParserCandidate,
  machine: QuickReportMetrics["machine"],
  deps: FamilyParserDeps
) {
  const lowerPath = candidate.normalizedPath.toLowerCase();
  if (!machine.device && lowerPath.endsWith("wm_data.tdf")) {
    machine.device = "SOMNOsoft2";
  }

  if (!machine.device) {
    if (/somnobalance/i.test(text)) machine.device = "Somnobalance";
    else if (/somnosoft2/i.test(text)) machine.device = "SOMNOsoft2";
    else if (/weinmann/i.test(text)) machine.device = "Weinmann";
  }

  const kv = deps.parseKeyValueLines(text);
  const modeRaw = kv.get("mode") ?? kv.get("Mode") ?? kv.get("therapy mode");
  if (!machine.mode && modeRaw) {
    if (/\b(?:auto|apap|balance)\b/i.test(modeRaw)) machine.mode = "APAP";
    else if (/\b(?:bilevel|bipap|st)\b/i.test(modeRaw)) machine.mode = "BiPAP";
    else if (/\bcpap\b/i.test(modeRaw)) machine.mode = "CPAP";
  }

  if (!machine.mode) {
    if (/somnobalance/i.test(text)) machine.mode = "APAP";
    else if (/somnosoft/i.test(text)) machine.mode = "CPAP";
  }
}

export async function parseWeinmannFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  await runTextFamilyParser(context, deps, {
    inferFamilyMachineSettings: (text, candidate, machine, familyDeps) => {
      inferWeinmannMachineSettings(text, candidate, machine, familyDeps);
    }
  });
}
