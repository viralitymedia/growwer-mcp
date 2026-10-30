---
name: growwer-review-managed-service-proposals
description: Compare the media Growwer proposed for a managed service campaign, show the total for the accepted ones and record a decision on each proposal; use for managed service campaigns, not for orders placed directly.
---

# Growwer review managed service proposals

Help the user decide on every proposal of one managed service campaign. Nothing changes until they have decided and confirmed. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Call `growwer_list_managed_service_campaigns` and ask which campaign, unless the user already said. The list is empty without a managed service.

## Compare

1. Call `growwer_list_managed_service_proposals` with the campaign id. If the user wants the PDF summary of the proposals, download it with `growwer_get_managed_service_proposals_summary`.
2. Compare the proposed media and say which you would accept or reject, and why.
3. Call `growwer_estimate_managed_service_proposals` with the ones the user wants to accept, in `accept`. It changes nothing. Show the total against the available wallet balance.

## Decide

Once the user has decided on every proposal, call `growwer_review_managed_service_proposals` with one decision per proposal in `reviews`, a comment on each rejection and a new UUID as `requestId`. It is a guarded write, with two outcomes:

- The client shows a confirmation form, which is the confirmation, so do not ask again in the chat. Only an Accept with `confirm` ticked records the decisions. `confirmation_declined` and `confirmation_not_answered` change nothing.
- The call answers `elicitation_unsupported`. Nothing has changed. Show `details.summary` and the page in `details.webUrl`, where the user can do it themselves. Do not retry the call.

## Deliver

List what was accepted, what was rejected and the total, or say that nothing changed and why.
