---
name: growwer-safe-purchase
description: Estimate a Growwer order, show its price against the wallet balance, then place it at that price through a confirmed write; use to buy an article or a link addition on a medium, not to choose one.
---

# Growwer safe purchase

Buy an article or a link addition with no surprise charge. The price the user saw is the price they confirm, and nothing is charged before they do. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Ordering needs write access: the write scope on an OAuth connection, or a read and write API key. If this connection is read-only, say so and let the user reconnect rather than retrying.
- Make sure you know the project, the medium, the type (`post` or `link_addition`) and the briefing. Ask for whatever is missing.

## Estimate

Call `growwer_estimate_order` with those arguments. It changes nothing. Show its price and how it compares with the available wallet balance. If the balance falls short, stop here and say so: wallet top-ups happen on growwer.com.

## Order

Once the user says to go ahead, call `growwer_create_order` with the same arguments, the estimated price as `expectedPrice` and a new UUID as `requestId`. Do not ask for confirmation in the chat again: the call itself asks.

## Read the outcome

There are two paths, and both are safe.

- The client shows a confirmation form. Only an Accept with `confirm` ticked places the order. `confirmation_declined` and `confirmation_not_answered` change nothing; ask the user before calling again. `price_changed` means the price moved and nothing was charged, so estimate again.
- The client cannot show forms, and the call answers `elicitation_unsupported`. Nothing was charged. Show `details.summary` and the page in `details.webUrl`, where the user can place the order themselves. Do not retry the call.

## Retry safely

To retry a call that failed on the way, send the same `requestId` with the same arguments: it returns the first result without ordering twice. A new order takes a new `requestId`. If the upstream lost the call's connection, an error may say the call may have run; repeat it with the same `requestId` to learn the outcome.

## Deliver

State what was ordered, for which project and at what price, or that nothing was charged and why.
