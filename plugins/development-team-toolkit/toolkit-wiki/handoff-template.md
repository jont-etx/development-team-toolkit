# Handoff: <short title>

Copy this file into the project's records, fill every section, then run
`node <plugin-root>/bin/toolkit.mjs handoff check <file>` from the project checkout.
Sections marked required must be filled; the check names any that are missing.

## Decision

<!-- required: a stable decision ID and the approved choice, e.g. "D-014: cache search results per region" -->

## Base revision

<!-- required: the commit the next owner starts from (7 to 40 hex characters) -->

## Owned files

<!-- required: one repo-relative path per bullet; the next owner edits only these -->
- 

## Acceptance checks

<!-- required: one check per bullet that proves the work is done, e.g. a test command or an observable result -->
- 

## Next owner

<!-- required: the exact role id who acts next (developer, qa-code, toolkit-qa-code, ...) or "owner"; unknown names are refused -->

## Runtime

<!-- required when the project's review policy applies (hot paths, or always): which runtime built the work and which reviewed it -->
- built:
- reviewed:

<!-- if the other runtime is unavailable, add: "cross-family review pending: <runtime> unavailable" -->

## Gates

<!-- tests first: required on the project's hot paths (Test Engineer RED test evidence), unless this handoff goes to the Test Engineer -->
<!-- release: yes when this handoff hands over a release candidate; then a Release Reviewer "go" is required -->
<!-- trigger: required for a Security Reviewer handoff: the named trigger, e.g. "credentials (API token store)"; otherwise none -->
- tests first: 
- release: no
- release reviewer:
- trigger: none

## Evidence

<!-- optional: links or paths to what supports the decision -->

## Unresolved

<!-- optional: open questions and pending approvals; write "none" if there are none -->
