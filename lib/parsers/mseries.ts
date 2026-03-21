import type { FamilyParserContext, FamilyParserDeps } from "@/lib/parsers/text-family-types";

function readNullTerminatedAscii(bytes: Uint8Array, start: number, maxLength: number): string {
  const end = Math.min(bytes.length, start + maxLength);
  let out = "";
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === 0) break;
    if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
  }
  return out.trim();
}

function inferMode(model: string, textData: string): string {
  const combined = `${model} ${textData}`;
  if (/\b(?:bipap|s\/?t|vent)\b/i.test(combined)) return "BiPAP";
  if (/\b(?:auto|smartauto|apap)\b/i.test(combined)) return "APAP";
  return "CPAP";
}

export async function parseMSeriesFamily(context: FamilyParserContext, deps: FamilyParserDeps): Promise<void> {
  const candidate = context.candidates.find((entry) => /(?:^|\/)therapy\.dat$/i.test(entry.normalizedPath)) ?? context.candidates[0];
  if (!candidate) return;

  deps.emit(context.onProgress, {
    phase: "parse",
    detail: `Reading ${candidate.normalizedPath}`,
    percent: Math.min(context.progressEnd, context.progressStart + 4)
  });

  try {
    const bytes = await candidate.file.readBytes();
    if (bytes.length !== 32768) {
      context.warnings.push("M-Series smartcard block size was unexpected; metadata parsing may be incomplete.");
      return;
    }

    const magic = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    if (magic !== 0x5249) {
      context.warnings.push("M-Series smartcard magic header was invalid.");
      return;
    }

    const userOffset = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
    if (userOffset <= 0 || userOffset + 0x77 >= bytes.length) {
      context.warnings.push("M-Series user info block was out of range.");
      return;
    }

    const serial = readNullTerminatedAscii(bytes, userOffset + 0x43, 50).slice(0, 10);
    const model = readNullTerminatedAscii(bytes, userOffset + 0x4d, 10);
    const textData = readNullTerminatedAscii(bytes, userOffset + 0x57, 0x20);
    const setName = readNullTerminatedAscii(bytes, userOffset + 0x01, 16);

    if (!context.machine.device) {
      if (model && serial) context.machine.device = `${model} (${serial})`;
      else if (model) context.machine.device = model;
      else if (serial) context.machine.device = `M-Series (${serial})`;
      else if (setName) context.machine.device = `M-Series ${setName}`.trim();
      else context.machine.device = "Philips Respironics M-Series";
    }

    const mode = inferMode(model, textData);
    context.machine.mode = mode;
    if (mode === "APAP") context.machine.pressureIsAuto = true;

    deps.inferMachineSettingsFromText(textData, context.machine);
    const kv = deps.parseKeyValueLines(textData.replace(/;/g, "\n"));
    if (kv.size > 0) {
      deps.inferPressureSettingsFromMap(kv, context.machine);
      deps.inferBilevelSettingsFromMap(kv, context.machine);
      deps.inferPressureReliefFromMap(kv, context.machine);
    }

    context.warnings.push(
      "M-Series smartcard metadata was identified, but OSCAR's reference loader does not expose full daily efficacy parsing for browser quick-report parity yet."
    );
  } catch {
    context.warnings.push("Could not read M-Series smartcard metadata.");
  }
}
