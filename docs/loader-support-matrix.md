# Loader Support Matrix

Engineering reference for the webapp parser stack. This tracks how the current webapp maps to the local OSCAR reference copy under `/OSCAR-code-ref-2/oscar/SleepLib/loader_plugins`.

## Column meanings

- `Detected`: the webapp can identify the file structure as that OSCAR loader family.
- `Quick Report`: the family is allowed through the CPAP/NIV clinician quick-report path.
- `Parser depth`:
  - `Structured`: family has a custom non-generic parse path.
  - `Dedicated`: family has its own parser module and family-specific logic.
  - `Metadata-only`: family-specific identification/settings exist, but daily efficacy parity is not implemented.
  - `Recognized only`: detector exists, but family is intentionally rejected for quick report use.

## CPAP / NIV families

| Family | OSCAR loader | Detected | Quick Report | Parser depth | Current notes |
|---|---|---:|---:|---|---|
| Resvent / Hoffrichter | `resvent_loader.cpp` | Yes | Yes | Structured | Main CPAP/NIV structured path with config/stat/event/leak handling. |
| ResMed | `resmed_loader.cpp` | Yes | Yes | Dedicated | Dedicated parser with `STR.edf` summary handling and family-specific mode/settings extraction. |
| Philips Respironics System One / DreamStation | `prs1_loader.cpp`, `prs1_parser*.cpp` | Yes | Yes | Dedicated | Dedicated binary/session parsing for major PRS1 family 0 xPAP flows. Vent/ASV parity is still thinner than desktop OSCAR. |
| Philips Respironics M-Series | `mseries_loader.cpp` | Yes | Yes | Metadata-only | Smartcard metadata and mode detection exist. Daily efficacy parity is not complete. |
| Loewenstein / Prisma | `prisma_loader.cpp` | Yes | Yes | Dedicated | Includes `therapy.pdat` inner-archive extraction plus Prisma-specific parameter/event handling. |
| Weinmann / Loewenstein | `weinmann_loader.cpp` | Yes | Yes | Dedicated | Binary `WM_DATA.TDF` compliance/event parsing is present, but still lighter than full OSCAR waveform/session reconstruction. |
| Apex / BMC / Luna | `bmc_loader.cpp`, `bmcDataParsing.cpp` | Yes | Yes | Dedicated | Dedicated `.USR` / `.IDX` parsing with session history and settings extraction. |
| DeVilbiss IntelliPAP | `intellipap_loader.cpp` | Yes | Yes | Dedicated | Dedicated DV5 and DV6 handling from family-specific files. |
| Fisher & Paykel SleepStyle | `sleepstyle_loader.cpp` | Yes | Yes | Dedicated | Dedicated parser for `SUM/DET/HIS/HRD` family files. |
| Fisher & Paykel ICON | `icon_loader.cpp` | Yes | Yes | Dedicated | Dedicated parser for `SUM/DET/FLW` family files. |
| vREM | `vrem_loader.cpp` | Yes | Yes | Dedicated | Dedicated parser for `PI.txt`, `DI.txt`, and `OD*` packet streams. |

## Recognized but intentionally not loadable in quick report workflow

These are present in the OSCAR reference tree and now recognized by the webapp detector, but they are not part of the CPAP/NIV clinician quick-report path.

| Family | OSCAR loader | Detected | Quick Report | Parser depth | Reason |
|---|---|---:|---:|---|---|
| Yuwell | `yuwell_loader.cpp` | Yes | No | Recognized only | Not part of the supported CPAP/NIV quick-report path yet. |
| Dreem | `dreem_loader.cpp` | Yes | No | Recognized only | Non-target device family for current clinician report workflow. |
| Viatom | `viatom_loader.cpp` | Yes | No | Recognized only | Oximetry/adjunct family, not CPAP/NIV report source. |
| CMS50 | `cms50_loader.cpp` | Yes | No | Recognized only | Oximeter family, not CPAP/NIV report source. |
| CMS50F37 | `cms50f37_loader.cpp` | Yes | No | Recognized only | Oximeter family, not CPAP/NIV report source. |
| MD300W1 | `md300w1_loader.cpp` | Yes | No | Recognized only | Oximeter `.dat` family, not CPAP/NIV report source. |
| Somnopose | `somnopose_loader.cpp` | Yes | No | Recognized only | Positional CSV loader, not CPAP/NIV report source. |
| Zeo | `zeo_loader.cpp` | Yes | No | Recognized only | Sleep-stage/adjunct loader, not CPAP/NIV report source. |

## Family detection notes

- The quick-report path is strict. If a supported CPAP/NIV family is not detected, the app errors instead of falling back to generic parsing.
- `SleepStyle` vs `ICON` is refined after initial ranking by reading F&P header content, because both families share overlapping path layout.
- `MD300W1` and `Somnopose` need content sniffing:
  - `MD300W1` from MedView-style `.dat` record layout.
  - `Somnopose` from CSV headers containing `timestamp` plus positional fields.

## Remaining high-value parity work

1. Deeper PRS1 ventilator / ASV parity against OSCAR `prs1_parser_vent.cpp` and `prs1_parser_asv.cpp`.
2. Better ResMed parity across additional EDF channels beyond the current summary-centric pass.
3. Better M-Series support if a clinically defensible daily efficacy interpretation can be derived from the smartcard structure.
4. Real sample-card comparison against OSCAR desktop for every loadable family.
