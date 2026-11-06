---
name: growwer-find-media-for-project
description: Search the Growwer catalogue for media that fit one of the user's projects, check whether a given media is among those Growwer recommends for it, compare the best candidates and recommend a shortlist; use to choose where to publish, not to place an order.
---

# Growwer find media for a project

Find media to publish on for one project and recommend a shortlist the user can judge, or answer whether a given media is among those Growwer recommends for it. Nothing is ordered here. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Call `growwer_list_projects` and take the project the user named, by its name or its website. Ask which project this is for only when the user named none, or when more than one project matches.

## A question about one media

When the user names a domain, or asks whether a given media is among those Growwer recommends for the project, answer that question directly. Do not ask first for budget, language, country, topics or metrics.

1. Call `growwer_search_project_medias` with the project id, `source` `recommended` and the named domain as `domain`. The filter matches every domain that contains the text, so pick the media whose `domain` is the one the user named.
2. If it is there, say it is among the media Growwer recommends for the project, and give its domain rating from `metrics.domainRating` and its post price from `postOffer.price`, as the answer gives them: `amountDecimal` in `currency`, or `amount` in cents. A null domain rating has not been measured yet, and a null `postOffer` means the media sells no post; say so rather than giving a figure.
3. If it is not there, say it is not among the media Growwer recommends for the project.

Stop there unless the user asks for more, such as other candidates.

## A shortlist

- Ask for what the user has not stated: budget per article, language, country, topics, and the minimum traffic or domain rating they accept.
- Take the ids of languages, countries and topics from `growwer_get_vocabulary`. Never guess them.

1. Call `growwer_search_project_medias` with the project id and those filters. Use source `recommended` when the user wants Growwer's recommendations for the project.
2. Open the best candidates with `growwer_get_catalogue_media`.
3. Compare them in a short table: price, traffic, domain rating, language and any condition that could rule one out.

## Handle refusals

- `catalogue_requires_recent_order`: the full catalogue opens after a recent delivered order, and until then a small daily trial quota applies. Explain that instead of retrying.
- `catalogue_daily_cap_reached`: the account saw its daily quota of distinct media. Explain that, and that it can retry after the delay in the message.

## Deliver

For a question about one media, give the answer and its figures. For a shortlist, recommend it and say why each medium earned its place. Either way, state that nothing was ordered: estimating and buying is a separate step, and the user decides it.
