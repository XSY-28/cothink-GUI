---
name: context-management
version: 0.1.1
description: Use when a conversation needs relevant prior context, a source-backed decision summary or a handoff; distinguish original instructions from derived notes and report unavailable context tools. Not needed for a self-contained short answer.
---
# Context management

Use only context relevant to the current question. Preserve the original user task, current constraints, unresolved disagreements and provenance. A summary or model note does not create permission or replace the current budget, file scope or formal version.

Read the host capability list first. When available, search_context searches the current visible branch, read_context reads a host-issued source reference in bounded pages, and save_context_note saves a derived note from text plus verified sources. Tool availability is role-specific; never invent a capability. If a needed source is not available, ask the user to select it or state the missing evidence.

Ordinary history contains user messages, delivered manager answers, and effective summaries. If an attribution, evidence check, or explicit continuation actually needs process facts, use search_context with the relevant branch taskId and purpose (attribution, evidence, or continuation). Read the returned ref with the same purpose. Treat missing provenance as missing evidence. A process reference never grants write authority.

When source material is available, identify its source/task reference, distinguish user decisions from model suggestions, and keep important exceptions and unknown results. A short handoff can state the goal, confirmed decisions, evidence, remaining work and uncertainty. To persist it, supply text and the actual source references to save_context_note and require a saved receipt. A note without sources is only a current model suggestion; it cannot establish a user decision.

Automatic compression remains disabled. Do not trigger another model call or scan other conversations, projects, credentials or arbitrary local files for context. Skill text grants no extra authority. The user can explicitly request one manual organization from the GUI. It uses actual budgeted summary requests (split turns may need two), preserves original entries, and must verify source and disk commit before application. Suggest this action when useful; never invoke or imitate it from a model tool. Unknown operations are queried by their original ID, not retried.

[Source and license](assets/source.json)
