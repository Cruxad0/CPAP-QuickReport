import type { FamilyParserContext, FamilyParserDeps, FamilyTextHooks } from "@/lib/parsers/text-family-types";
import { extractExplicitUtcOffsetMinutes } from "@/lib/timezone";
import type { ParsedRecord } from "@/lib/types";

export async function runTextFamilyParser(
  context: FamilyParserContext,
  deps: FamilyParserDeps,
  hooks: FamilyTextHooks = {}
): Promise<void> {
  let processed = 0;

  for (const candidate of context.candidates) {
    processed += 1;
    const pct =
      context.progressStart +
      Math.round((processed / Math.max(1, context.candidates.length)) * (context.progressEnd - context.progressStart));

    deps.emit(context.onProgress, {
      phase: "parse",
      detail: `Reading ${candidate.normalizedPath}`,
      percent: Math.min(context.progressEnd, pct)
    });

    try {
      const bytes = await candidate.file.readBytes();
      const variants = deps.decodeLikelyTextVariants(bytes);
      if (variants.length === 0) continue;

      let bestVariantRecords: ParsedRecord[] = [];
      for (const text of variants) {
        hooks.inferFamilyMachineSettings?.(text, candidate, context.machine, deps);
        deps.inferMachineSettingsFromText(text, context.machine);

        const kv = deps.parseKeyValueLines(text);
        if (kv.size > 0) {
          if (context.sourceTimeZoneOffsetMinutes === null) {
            const explicitUtcOffsetMinutes = extractExplicitUtcOffsetMinutes(kv);
            if (explicitUtcOffsetMinutes !== null) {
              context.sourceTimeZoneOffsetMinutes = explicitUtcOffsetMinutes;
            }
          }
          deps.inferPressureSettingsFromMap(kv, context.machine);
          deps.inferBilevelSettingsFromMap(kv, context.machine);
          deps.inferPressureReliefFromMap(kv, context.machine);
        }

        const variantRecords: ParsedRecord[] = [];
        if (candidate.recordDate) {
          const statLike = deps.parseResventStatText(text, candidate.recordDate);
          if (statLike) {
            variantRecords.push(statLike);
          } else {
            const genericDaily = deps.parseGenericDailyKeyValueRecord(text, candidate.recordDate);
            if (genericDaily) variantRecords.push(genericDaily);
          }
        }

        variantRecords.push(...deps.sanitizeRecords(deps.parseRecords(text)));
        const dedupedVariantRecords = deps.dedupeParsedRecords(variantRecords);
        if (dedupedVariantRecords.length > bestVariantRecords.length) {
          bestVariantRecords = dedupedVariantRecords;
        }
      }

      if (bestVariantRecords.length > 0) {
        context.records.push(...bestVariantRecords);
      }
    } catch {
      continue;
    }

    if (processed % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
