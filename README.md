# QENDROVA Evidence Graph

Private V4 review package for the Relate by Neo4j hackathon.

QENDROVA helps a decision owner examine whether a source applies to a
specific claim. It keeps supporting and opposing evidence visible, explains
why some records were excluded, and displays the human decision separately.

## Run the four cases

Use Node.js 24 and npm. This package was checked on Windows x64 with Node.js
24.18.0. Start in a fresh extraction of the ZIP.

```sh
npm ci --ignore-scripts
npm run import:fixtures
npm run serve
```

In Windows PowerShell, use `npm.cmd` if `npm` resolves to a blocked PowerShell
script. Installation uses the public npm registry. After installation, the
app runs locally with no account, credentials, or model calls.

Open the [construction comparison](http://127.0.0.1:4173/en/case/case-construction-before).
Use the links to inspect the evidence for [case A](http://127.0.0.1:4173/en/case/case-construction-before#claim-construction-recess-before)
and [case B](http://127.0.0.1:4173/en/case/case-construction-after#claim-construction-recess-after).
The case menu also opens the laptop and historical rules cases. The language
link switches the interface between English and German.

Stop the server with Ctrl+C. The import creates
`.data/qendrova-evidence-phase3.rl`, a single embedded Relate database file.
This mode keeps the graph local and lets a new process reopen the same stored
evidence. The import requires an empty target. Use a fresh extraction to
repeat the setup, or restart the server to reopen the original database.

To reproduce the construction comparison in separate report processes, stop
the server and run:

```sh
node src/report.cjs .data/qendrova-evidence-phase3.rl case-construction-before
node src/report.cjs .data/qendrova-evidence-phase3.rl case-construction-after
```

Each report contains the evaluated claims and actual Relate paths. To verify
the import, evidence checks and local HTTP views, run the full suite in
sequence:

```sh
node --test --test-concurrency=1
```

## What to inspect

1. **Construction comparison.** Case A has records for the flat slab and
   an earlier revision. The documentation claim for the recess in revision B
   remains unproved. Case B adds one reviewed record for that exact recess and
   revision. The documentation claim gains one supporting record. In both
   cases the flat-area and stale records stay excluded for the recess. The
   register conflict and the human decision to request clarification remain.
   Open the evidence details to inspect the exclusion or trace the new record
   through its passage, source, scope and review. This is a fictional
   documentation check. Engineering sign-off remains a separate decision.
2. **Laptop case.** The EUR 899 delivered price gives context. The EUR 1,120
   estimate includes the required accessories and setup and opposes the
   total-budget claim. A 90-day parts warranty gives context for the repair.
   Its actual reliability over twelve months remains unproved.
3. **Historical rules case.** Six claims use labelled paraphrases of two public
   sources, checked on 19 November 2026. Open the source link in the evidence
   details for the original passage. Use the current official rules for an
   actual contest entry.

## Implementation and provenance

The importer validates bounded JSON and writes into embedded Relate 1.1.0.
At review time, Relate runs fixed parameterized queries along the
case–option–claim–assertion–passage–source path. The JavaScript evaluator
also checks schema, dates and expected connections and explains exclusions.
The graph view displays Relate's returned topology. Reports contain the
evaluated status.

The laptop and construction records are synthetic. The historical rules case
uses short paraphrases of the [Relate rules](https://relate.devpost.com/rules)
and [competition overview](https://relate.devpost.com/), with source locators
in the fixture. The standalone module and fixtures were written during the
contest period. Earlier QENDROVA and Apart work supplied the general idea of
keeping claims, evidence and human decisions separate. Flamur Koca's rebar
work supplied the documentation question behind the fictional construction
case: whether a record for a flat area also applies to a recess. AI assisted
with implementation, tests, wording and drafting fixtures. The application
evaluates the stored records locally without model calls.

The prototype evaluates the supplied cases and stored records. It does not
determine real-world truth or approve any option. Local hashes help detect
accidental changes. A writer who can change both a record and its stored
hash could make them agree again.

## License

The original software, tests, fixtures and documentation in this
standalone contest module are licensed under the [Apache License, Version
2.0](LICENSE). The official sources referenced in the fixtures retain their
own terms. Installed dependencies retain the licenses listed in
[Third-party notices](THIRD-PARTY-NOTICES.md).
