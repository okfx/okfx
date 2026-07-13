---
type: Metric
title: Weekly Active Users
description: Number of unique users active in the last 7 days.
owner: analytics-team
resource: https://docs.example.com/metrics/wau
tags:
  - analytics
  - engagement
timestamp: 2026-07-07T00:00:00.000Z
---

# Weekly Active Users

Weekly Active Users measures the number of unique users who performed at least one qualifying event in the last 7 days.

## Usage

Use this metric to monitor weekly engagement trends and compare cohorts.

## Source Tables

- [User Events](../tables/user_events.md)

## Calculation

Count distinct `user_id` where `event_timestamp` is within the last 7 days.

## Notes

This metric excludes internal test users.
