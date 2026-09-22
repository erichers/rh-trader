# Fox backtest rank

Paper only. Fox reads `fox_rank` on the existing leaderboard and scan routes. There is no second table.

- `GET /api/quickbots/leaderboard`
- `POST /api/backtest/scan`

Shape id: `fox.backtest_rank.v1`.

```json
{
  "shape": "fox.backtest_rank.v1",
  "preferred_bot_ids": [86, 39, 88],
  "preferred_note": "Measure these paper bots first. They have fills: 86 G4 NVDA, 39 Index QuickBot, 88 G8 trail.",
  "rank": [
    {
      "kind": "play",
      "symbol": "SPY",
      "strategy": "momo_up",
      "label": "Up momentum",
      "dte": 7,
      "bot_id": null,
      "expectancy_pct": 1.2,
      "trades": 12,
      "win_rate": 54,
      "max_drawdown_pct": -8.4,
      "total_return_pct": 15,
      "profit_factor": 1.4,
      "best_multiple": 2.1,
      "robust": true,
      "modeled": false,
      "preferred": false
    }
  ]
}
```

`rank[]` is symbol × strategy × DTE. Scores are the ones the quickbot backtest and the strategy scan already compute. Expectancy falls back to average return when a scan row has no expectancy field.

`preferred_bot_ids` is the measure order. When a row has `bot_id` 86, 39, or 88, that row sorts first, in that order. Leaderboard plays have a null bot id and follow those bots.

This shape does not promote a bot and does not turn Jev exit on.
