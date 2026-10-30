---
name: growwer-seller-fulfilment
description: Work through the orders placed on the user's Growwer media, accepting, delivering and answering update requests; use for the seller's side of an order, not to buy or to review a delivery as a buyer.
---

# Growwer seller fulfilment

Work through the orders placed on the user's media, the ones that need them first. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Each write takes a new UUID as `requestId`, and needs write access. If a write is refused for that, say so and let the user reconnect rather than retrying.
- If an answer is `seller_restricted`, stop and tell the user to contact support.

## Read

Call `growwer_list_seller_orders`, paging with `offset` and `limit` until `offset` reaches `total`. Lead with the orders whose `requiresYourAction` is true, grouped by state; `availableActions` says what each one allows now. Open any order the user asks about with `growwer_get_seller_order`, and its briefing or draft with `growwer_download_seller_order_briefing` and `growwer_download_seller_order_draft`.

## Act by state

- `pending_acceptance`: ask whether the user takes the order. Accept it with `growwer_accept_seller_order`. Reject it with `growwer_reject_seller_order` and the user's reason. The buyer gets the price back, so rejecting is a guarded write, with two outcomes:
  - The client shows a confirmation form, which is the confirmation, so do not ask again in the chat. Only an Accept with `confirm` ticked rejects the order. `confirmation_declined` and `confirmation_not_answered` change nothing.
  - The call answers `elicitation_unsupported`. Nothing has changed. Show `details.summary` and the page in `details.webUrl`, where the user can reject it themselves. Do not retry the call.
- `pending_draft`, a post order the user writes: upload the file with `growwer_upload_file` and deliver the id it answers as `fileId` with `growwer_deliver_seller_order_draft`.
- `pending_draft_update`: the buyer asked for changes to the draft. Either upload the new file and deliver it as `fileId` with `growwer_deliver_seller_order_draft_update`, or refuse with `growwer_refute_seller_order_draft_update` and the user's reason.
- `pending_order_delivery`, once published: deliver it with `growwer_deliver_seller_order`. A post order takes the `url` of the post, which the user gives you, and `publicationDateConfirmed` true once they confirm the date. A link addition takes neither.
- `pending_order_delivery_update`: either deliver the change with `growwer_deliver_seller_order_update`, which takes the same fields as the delivery, or refuse it with `growwer_refute_seller_order_update` and the user's reason.
- `scheduled`: the order publishes on its date and needs nothing from the user.

## Deliver

Say what you did on each order and what still waits, and for whom.
