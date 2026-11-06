---
name: growwer-wallet-and-spend-report
description: Report the user's Growwer wallet balances, movements, invoices, spend and earnings for a period; use for a money report, not to move funds, which happens on growwer.com.
---

# Growwer wallet and spend report

Report the user's money on Growwer for the period they name, or the last 30 days if they name none. This report changes nothing. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Call `growwer_get_me`. It gives the buyer and the seller balances and does not say which side the user is on, so cover both.

## Gather

1. Buyer side: `growwer_get_buyer_wallet` for the balance, `growwer_list_buyer_transactions` for the movements, then `growwer_list_invoices` for the invoices of the top-ups.
2. Seller side: `growwer_get_seller_wallet` for what can be withdrawn and what is held, `growwer_list_seller_transactions` for the movements and `growwer_list_withdrawals` for the withdrawals.
3. Page each list with `offset` and `limit`, until `offset` reaches `total` or the movements fall before the period. The lists come newest first.

Read amounts exactly as the tools answer them, preferring `amountDecimal` in its `currency` to `amount` in cents. Never work out a figure the tools did not give, with one exception: the spend of the period.

## Spend of the period

No tool answers the spend of a period, so add it up from the buyer movements:

- Take the movements of `growwer_list_buyer_transactions` whose `type` is `debit_from_order` and whose `createdAt` falls in the period, from every page of the period, not only the first.
- Leave out those whose `state` is `cancelled`: their order was refunded. Count `pending_confirmation` and `confirmed` ones.
- Add their `amountDecimal`, or their `amount` in cents where `amountDecimal` is missing, and keep a separate total for each currency.

State the result as the sum of the order debits the transaction list shows, name the period with its dates, and say how many debits it adds up and how many refunded ones it leaves out.

## Deliver

Report the balances, the spend of the period, the seller's earnings of the period as its movements list them, and the largest movements. A side with no balance and no movements gets one line saying so.
