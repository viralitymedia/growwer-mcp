---
name: growwer-track-orders
description: Show where the user's Growwer orders stand, lead with what waits for them, and act on the drafts and deliveries they decide on; use to follow or review orders as a buyer, not to fulfil them as a seller.
---

# Growwer track orders

Show where the user's orders stand and what waits for them. Give a view on each delivery or draft, then act only on the user's word. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Acting on an order needs write access. If a write is refused for that, say so and let the user reconnect rather than retrying.

## Read

1. Call `growwer_list_orders`, filtering by state or `projectId` if the user asked for it, and page with `offset` and `limit` until `offset` reaches `total`.
2. Group the orders by `pendingAction`:
   - `buyer` first, which waits for the user: `pending_order_delivery_review` is a delivery to review and `pending_draft_review` a draft to review.
   - `seller` or `growwer` next, which the user only waits for.
   - No `pendingAction` last: scheduled orders, which publish on their date, and finished ones.
3. Open any order the user asks about with `growwer_get_order`. Read a post order's draft with `growwer_download_order_draft`.

## Act on the user's word

Each of these writes takes a new UUID as `requestId`.

- Accept a delivery with `growwer_approve_order`. The seller is paid and it cannot be undone, so it is a guarded write, with two outcomes:
  - The client shows a confirmation form, which is the confirmation, so do not ask again in the chat. Only an Accept with `confirm` ticked approves it. `confirmation_declined` and `confirmation_not_answered` change nothing.
  - The call answers `elicitation_unsupported`. Nothing has changed. Show `details.summary` and the page in `details.webUrl`, where the user can approve it themselves. Do not retry the call.
- Ask for changes to a delivery with `growwer_request_order_update`, with the user's reason.
- Accept a draft with `growwer_approve_order_draft`, or ask for changes with `growwer_request_order_draft_update`, with the user's reason.

## Deliver

Summarise what waits for the user, what waits for others and what you changed. Say plainly when nothing changed.
