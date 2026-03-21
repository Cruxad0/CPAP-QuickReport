import { runTextFamilyParser } from "@/lib/parsers/text-family-runner";
import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";
import type { QuickReportMetrics } from "@/lib/types";

type CanonicalMode = "CPAP" | "APAP" | "BiPAP";

const PRS1_EXACT_MODELS = new Map<string, { label: string; mode: CanonicalMode }>([
  ["251P", { label: "REMstar Plus (System One)", mode: "CPAP" }],
  ["450P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["451P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["452P", { label: "REMstar Pro (System One)", mode: "CPAP" }],
  ["550P", { label: "REMstar Auto (System One)", mode: "APAP" }],
  ["551P", { label: "REMstar Auto (System One)", mode: "APAP" }],
  ["552P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["650P", { label: "BiPAP Pro (System One)", mode: "BiPAP" }],
  ["750P", { label: "BiPAP Auto (System One)", mode: "BiPAP" }],
  ["261CA", { label: "REMstar Plus (System One 60 Series)", mode: "CPAP" }],
  ["261P", { label: "REMstar Plus (System One 60 Series)", mode: "CPAP" }],
  ["460P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["460PBT", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["461P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["462P", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["461CA", { label: "REMstar Pro (System One 60 Series)", mode: "CPAP" }],
  ["560P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["560PBT", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["561P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["562P", { label: "REMstar Auto (System One 60 Series)", mode: "APAP" }],
  ["660P", { label: "BiPAP Pro (System One 60 Series)", mode: "BiPAP" }],
  ["760P", { label: "BiPAP Auto (System One 60 Series)", mode: "BiPAP" }],
  ["761P", { label: "BiPAP Auto (System One 60 Series)", mode: "BiPAP" }],
  ["501V", { label: "Dorma 500 Auto (System One 60 Series)", mode: "APAP" }],
  ["200X110", { label: "DreamStation CPAP", mode: "CPAP" }],
  ["400G110", { label: "DreamStation Go", mode: "CPAP" }],
  ["400X110", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X120", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X130", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["400X150", { label: "DreamStation CPAP Pro", mode: "CPAP" }],
  ["401X150", { label: "DreamStation CPAP Pro with Auto-Trial", mode: "APAP" }],
  ["500X110", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X120", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X130", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X140", { label: "DreamStation Auto CPAP with A-Flex", mode: "APAP" }],
  ["500X150", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["500X180", { label: "DreamStation Auto CPAP", mode: "APAP" }],
  ["501X120", { label: "DreamStation Auto CPAP with P-Flex", mode: "APAP" }],
  ["500G110", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["500G120", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["500G150", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["502G150", { label: "DreamStation Go Auto", mode: "APAP" }],
  ["600X110", { label: "DreamStation BiPAP Pro", mode: "BiPAP" }],
  ["600X150", { label: "DreamStation BiPAP Pro", mode: "BiPAP" }],
  ["700X110", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X120", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X130", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["700X150", { label: "DreamStation Auto BiPAP", mode: "BiPAP" }],
  ["410X150C", { label: "DreamStation 2 CPAP", mode: "CPAP" }],
  ["420X150C", { label: "DreamStation 2 Advanced CPAP", mode: "CPAP" }],
  ["520X110C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520X130C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["520X150C", { label: "DreamStation 2 Auto CPAP Advanced", mode: "APAP" }],
  ["521X120C", { label: "DreamStation 2 Auto CPAP Advanced with P-Flex", mode: "APAP" }],
  ["521X140C", { label: "DreamStation 2 Auto CPAP Advanced with P-Flex", mode: "APAP" }],
  ["950P", { label: "BiPAP AutoSV Advanced System One", mode: "BiPAP" }],
  ["951P", { label: "BiPAP AutoSV Advanced System One", mode: "BiPAP" }],
  ["960P", { label: "BiPAP autoSV Advanced (System One 60 Series)", mode: "BiPAP" }],
  ["961P", { label: "BiPAP autoSV Advanced (System One 60 Series)", mode: "BiPAP" }],
  ["960T", { label: "BiPAP autoSV Advanced 30 (System One 60 Series)", mode: "BiPAP" }],
  ["961TCA", { label: "BiPAP autoSV Advanced 30 (System One 60 Series)", mode: "BiPAP" }],
  ["900X110", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["900X120", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["900X150", { label: "DreamStation BiPAP autoSV", mode: "BiPAP" }],
  ["1061401", { label: "BiPAP S/T (C Series)", mode: "BiPAP" }],
  ["1061T", { label: "BiPAP S/T 30 (System One 60 Series)", mode: "BiPAP" }],
  ["1160P", { label: "BiPAP AVAPS 30 (System One 60 Series)", mode: "BiPAP" }],
  ["1030X110", { label: "DreamStation BiPAP S/T 30", mode: "BiPAP" }],
  ["1030X150", { label: "DreamStation BiPAP S/T 30 with AAM", mode: "BiPAP" }],
  ["1130X110", { label: "DreamStation BiPAP AVAPS 30", mode: "BiPAP" }],
  ["1131X150", { label: "DreamStation BiPAP AVAPS 30 AE", mode: "BiPAP" }],
  ["1130X200", { label: "DreamStation BiPAP AVAPS 30", mode: "BiPAP" }]
]);

function readCaseInsensitive(map: Map<string, string>, keys: string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const [key, value] of map.entries()) lower.set(key.toLowerCase(), value);
  for (const key of keys) {
    const hit = map.get(key) ?? lower.get(key.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function inferModeFromModel(model: string): CanonicalMode | null {
  if (/^(?:2\d{2}[A-Z]*|4\d{2}[A-Z]*|410X150C|420X150C)$/i.test(model)) return "CPAP";
  if (/^(?:5\d{2}[A-Z]*|501V|520X110C|520X130C|520X150C|521X120C|521X140C)$/i.test(model)) return "APAP";
  if (/^(?:6\d{2}[A-Z]*|7\d{2}[A-Z]*|9\d{2}[A-Z]*|10\d{2}.*|11\d{2}.*|1030X110|1030X150|1061401|1061T|1130X110|1130X200|1131X150|1160P)$/i.test(model)) {
    return "BiPAP";
  }
  return null;
}

function inferPrs1MachineSettings(text: string, machine: QuickReportMetrics["machine"], deps: FamilyParserDeps) {
  const kv = deps.parseKeyValueLines(text);
  const modelRaw = readCaseInsensitive(kv, ["ModelNumber", "Model", "modelnumber", "model"]);
  const modeRaw = readCaseInsensitive(kv, ["Mode", "therapy mode", "CPAPMode"]);

  if (!machine.mode && modeRaw) {
    const normalized = modeRaw.trim();
    if (/\b(?:auto cpap|apap|auto)\b/i.test(normalized)) machine.mode = "APAP";
    else if (/\b(?:bipap|bilevel|asv|avaps|st)\b/i.test(normalized)) machine.mode = "BiPAP";
    else if (/\bcpap\b/i.test(normalized)) machine.mode = "CPAP";
  }

  const model = modelRaw?.trim().toUpperCase();
  if (model) {
    const exact = PRS1_EXACT_MODELS.get(model);
    if (!machine.device) {
      machine.device = exact?.label ?? `Philips Respironics ${model}`;
    }
    if (!machine.mode) {
      const inferredMode = exact?.mode ?? inferModeFromModel(model);
      if (inferredMode) machine.mode = inferredMode;
    }
  }
}

export async function parsePrs1Family(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  await runTextFamilyParser(context, deps, {
    inferFamilyMachineSettings: (text, _candidate, machine, familyDeps) => {
      inferPrs1MachineSettings(text, machine, familyDeps);
    }
  });
}
