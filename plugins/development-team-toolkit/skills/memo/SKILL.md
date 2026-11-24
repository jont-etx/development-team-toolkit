---
name: memo
description: Run the memo interview for a new initiative, module, section or next round of work, then triage new asks, keep follow-ups, and close rounds with a Done check. Use before any spec, plan or milestone is written, whenever the owner raises something new, or when the owner asks whether a round is done.
---

# Memo

A memo answers why, for whom, what not and what done looks like, in the owner's words, on one page, before anything is specified or built. The spec and plan then work out how and in what order. Every new initiative needs an approved memo before its spec, plan or milestones. The Interviewer runs it; the hub (PM) owns triage and the Done check. Write it from [the memo template](../../toolkit-wiki/memo-template.md).

## The interview

Ask **one question at a time**, in this order. Push back on vague answers: ask for a concrete example, a name, a number or an observable result until the line is specific. Reuse facts the project already settled (outcome metric, focus, not-build list, existing memos) instead of asking again, and say where each came from.

1. **What is this?** One sentence a user of the product would understand.
2. **Who is it for?** Name one **real** person the owner has actually talked to: a customer, a user or a staff member. A persona or audience profile does not count. **If no real person can be named, stop: the initiative does not proceed.**
3. **What is it NOT?** What it will not do, even if it seems related. Check the project's not-build list.
4. **What does DONE look like?** Something observable, tied to the project's outcome metric, or explicitly neither with the owner's approval.
5. **What is the smallest version that proves it?** The least that shows the idea works for the person in question 2. Then ask the hook question: **what is the least number of steps for them to experience the most valuable, unique thing that will get them hooked?** Record the hook, its step count and its starting point. The smallest proof must deliver the hook.
6. **What FEATURES do I want in this?** A short list. Anything not on it later is drift.

## What really matters for the proof

Read the answers back and split the features into two lists, which the owner confirms:

1. **Build to prove it:** only what the person in question 2 needs to show the smallest proof works and to reach the hook in its step count. Each item names the feature or question it proves. This sets the first milestone's scope.
2. **Don't build:** everything else, including real features the proof does not need. For each, name any existing tool that covers it instead: an app or open-source module already in the stack, a SaaS product, a spreadsheet or a manual step. Building one of these during the proof is drift.

Then ask: **what is the one signature moment the person would remember and tell someone else about?** Record it as the Memorable line: one moment, usually the hook made distinctive, built only after the proof is hardened.

## Levels

- **Project memo:** the same questions for the whole product; its features list is the short portfolio that matters now. Every hub reads it first.
- **Module memo:** the whole module; its features list names which section owns each feature and links every section memo. Write it the next time the module gets work.
- **Section memo:** one per hub or sub-project inside a module, covering only the features assigned to it. It links up to its module memo and normally inherits the module's person and hook. Write the module memo first.
- **Promoted drift:** before a parked drift item becomes a milestone, answer questions 2, 4 and 5 for it.

## Triage: every new ask, before any work

Whenever the owner raises something new, the hub (with the Interviewer when it is unclear) sorts it before any work starts and posts:

```text
Triage: <what was asked>
Fits: <outcome>, because <one line tied to the memos>
Options: <the 2-3 realistic choices, recommended first>
```

Outcomes:

1. **Current round:** already covered by this round's Done or build list. Do it.
2. **This section, later:** belongs here but beyond the current round. Add it to this memo's Follow-ups; the round does not change.
3. **Another section:** fits elsewhere. Add it to that section's Follow-ups (or its current round, if it fits that round's Done) and route it to that section's hub.
4. **New:** no section owns it. A new section or initiative, memo first.
5. **Ask:** it touches a round without fitting its Done, or straddles sections. Ask the owner with the options laid out; never guess.

Log every triage result with the section's decisions.

## Follow-ups

Each memo keeps a Follow-ups list: candidates for future rounds, each with its source (an owner ask, a drift item decided later, or a hand-off from another section) and a rough size. It is the single queue.

## Rounds

A memo is one round of work. `memo.md` is always the current round; a finished round never stops the section or its hub. Lifecycle: **active -> Done check signed off -> filed**, then the next round starts, or the section goes idle until the owner starts one.

### Done check

The hub opens it **automatically** once every milestone in the round is done, its journey checks pass and acceptance is approved; **on request** whenever the owner asks ("is this done?"), showing any gaps. It posts one card:

```text
Done check: <section> · round <name> (memo approved YYYY-MM-DD)

Done lines
  ✓ <Done line> — evidence: <link>
  ✗ <Done line> — missing: <what>
  ? <Done line> — unknown: <why>
Hook: target <N> steps · actual <n>
Memorable: acceptance answer "<owner's words>" · 30-day follow-up due <date>
Numbers: <outcome metric> baseline <x> -> now <y>
Still open: <drift items, follow-ups this round created>
Sign-off needed from: <the approver; for a hot path, any one of its listed approvers>
```

The owner answers **Sign off**; **Not yet** (name what is missing; it becomes the last work of the round, then the check is offered again); or **Done with exceptions** (sign off; unmet lines go to Follow-ups with the owner's note). Record a named approver's sign-off only from that person's explicit answer.

### After sign-off

1. Log the owner's exact words; the round's status becomes `shipped, signed off YYYY-MM-DD`.
2. File the round to `memos/YYYY-MM-DD-<name>.md` with the Done check attached, and add it to the new memo's Round history.
3. Record `Memorable follow-up due: YYYY-MM-DD` (30 days later), then its result: did the person mention it unprompted, or did someone they told ask about it?
4. **What's next?** Show this section's Follow-ups plus anything other sections sent here, and ask which to take on. An update to the same feature is a quick round (carry forward unchanged answers, usually For and Not; re-ask Done, Smallest proof, Hook, Memorable and Features). A new feature is a full round. Nothing now means the section goes idle.

## How the memo feeds the rest

Acceptance criteria come from Done and the features list. Done becomes the milestone endgame; the smallest proof becomes the first milestone. A feature not in the memo is drift. Changing the memo is a scope change the owner approves, and the memo records the new date.
