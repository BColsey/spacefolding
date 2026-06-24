# ADR-002: Functional Source License (FSL-1.1-ALv2)

- **Status:** Accepted (2026-06-17), by owner direction ("monetize").
- **Supersedes:** the "Spacefolding Personal Use License 1.0" (noncommercial /
  educational only, no price, contributions encumbered).

## Context

The prior license defined "commercial" to include internal business use, listed
no price, and licensed contributions under terms that legally encumbered any paid
model — incompatible with the frictionless-install + plugin-distribution strategy
and with monetization. The owner directed that the project be monetized.

## Decision

Relicense to **FSL-1.1-ALv2** (Functional Source License, ALv2 future), using the
official verbatim template from
[getsentry/fsl.software](https://github.com/getsentry/fsl.software). Only the
copyright notice (`Copyright 2024–2026 Benjamin Colsey`) was filled in; no other
license text was modified.

- Free for **Permitted Purposes**: internal use, non-commercial
  education/research, and professional services to a licensee.
- A **Competing Use** (substituting for / offering similar functionality as a
  commercial product or service) requires a separate **commercial license** — the
  monetization mechanism.
- Each release **auto-converts to Apache-2.0** two years after its availability
  date, keeping the project contributor- and community-friendly over time.

## Why FSL over the alternatives

- **vs Apache/MIT (open-core):** FSL blocks competitors from reselling or hosting
  the work, while still letting real users use it freely.
- **vs BUSL:** FSL needs no custom "use limitations" drafting — the Competing-Use
  definition is built in — and has a cleaner, automatic conversion. Better suited
  to a solo monetization play (no per-use legal drafting).
- **vs AGPL-3.0 + commercial dual-license:** FSL avoids the anti-AGPL adoption
  friction common among enterprise buyers — the monetization target.
- **vs the old restrictive + no-price model:** FSL permits legitimate developer
  use (the frictionless-install strategy) while still gating commercial
  competition.

## Consequences / open items

- `package.json` keeps `"license": "SEE LICENSE IN LICENSE"`. FSL-1.1-ALv2 is a
  valid SPDX id but not OSI-approved, so an explicit SPDX value would make npm
  emit a license warning; the SEE-LICENSE form stays accurate and warning-free.
- **Commercial-license contact + pricing are an open business item** (owner to
  fill in [`LICENSING.md`](../../LICENSING.md)): contact email, pricing page,
  and/or self-serve purchase link. This must be set before monetization actually
  operates.
- A CLA may be needed once commercial licensing begins (contributions are under
  FSL for now). Legal review of the final setup is recommended before any paid
  launch — this ADR records the model decision, not legal sign-off.
