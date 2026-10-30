---
name: growwer-find-media-for-project
description: Search the Growwer catalogue for media that fit one of the user's projects, compare the best candidates and recommend a shortlist; use to choose where to publish, not to place an order.
---

# Growwer find media for a project

Find media to publish on for one project and recommend a shortlist the user can judge. Nothing is ordered here. Respond in the user's language.

## Before starting

- Use the connected Growwer MCP tools. If they are unavailable or authentication fails, ask the user to connect Growwer.
- Call `growwer_list_projects` and ask which project this is for, unless the user already said.
- Ask for what the user has not stated: budget per article, language, country, topics, and the minimum traffic or domain rating they accept.
- Take the ids of languages, countries and topics from `growwer_get_vocabulary`. Never guess them.

## Search and compare

1. Call `growwer_search_project_medias` with the project id and those filters. Use source `recommended` when the user wants Growwer's recommendations for the project.
2. Open the best candidates with `growwer_get_catalogue_media`.
3. Compare them in a short table: price, traffic, domain rating, language and any condition that could rule one out.

## Handle refusals

- `catalogue_requires_recent_order`: the full catalogue opens after a recent delivered order, and until then a small daily trial quota applies. Explain that instead of retrying.
- `catalogue_daily_cap_reached`: the account saw its daily quota of distinct media. Explain that, and that it can retry after the delay in the message.

## Deliver

Recommend a shortlist and say why each medium earned its place. State that nothing was ordered: estimating and buying is a separate step, and the user decides it.
