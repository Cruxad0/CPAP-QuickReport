# Real Card Smoke Tests

These tests validate that the web parser can import actual SD-card folders end to end:

1. detect the correct loader family
2. parse machine settings
3. resolve therapy mode
4. build prepared day buckets
5. generate report metrics

## Setup

Copy the example manifest:

```bash
cp /Users/joelrodz/Sites/oscar-clinician-work/tests/fixtures/real-cards.manifest.example.json \
   /Users/joelrodz/Sites/oscar-clinician-work/tests/fixtures/real-cards.manifest.local.json
```

Edit the `.local.json` file and replace each `path` with the absolute path to a real SD-card root or a local card snapshot.

The `.local.json` file is gitignored so real patient data paths are not committed.

Optional fields for older snapshots:

- `windowEndClinicalDayIso`: explicitly anchor the report end day for that fixture
- `anchorToLatestData`: automatically anchor the report end day to the fixture's latest parsed clinical day

Use one of those when a fixture is older than the current date, otherwise a strict 90-day window can legitimately return no in-range records.

## Run

```bash
npm run test
```

If you want to keep the manifest elsewhere:

```bash
REAL_CARD_MANIFEST=/absolute/path/to/manifest.json npm run test
```

## Expectations

Each fixture can assert:

- `selectedLoaderIncludes`
- `mode`
- `deviceIncludes`
- `pressure`
- `pressureMin`
- `pressureMax`
- `epap`
- `ipap`
- `minDaysWithData`
- `minDaysWithUsage`

Start with broad assertions first:

- correct loader family
- correct therapy mode
- enough days with data

Then tighten settings assertions once the card is parsing correctly.

## Verified Public Fixture Source

The only verified public full-folder PAP fixtures currently wired into this workflow are the ResMed snapshots in the public `CPAP-Exporter` repository:

- [CPAP-Exporter](https://github.com/CascadePass/CPAP-Exporter)
- ResMed fixture root: `CPAP-Exporter.Integration.Tests/MachineData/ResMed`

Example manifest for those public fixtures:

```bash
cp /Users/joelrodz/Sites/oscar-clinician-work/tests/fixtures/public-resmed.manifest.example.json \
   /tmp/public-resmed.manifest.local.json
REAL_CARD_MANIFEST=/tmp/public-resmed.manifest.local.json npm run test -- tests/real-card-smoke.test.ts
```

Those entries use `anchorToLatestData: true` because the public fixtures are historical snapshots, not current-day SD cards.
