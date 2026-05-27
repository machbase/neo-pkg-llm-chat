# Rollup Rebuild Guide

## Overview

If anomalous data has already been collected, you can delete the raw data and insert corrected rows.
However, previously generated rollup statistics are not automatically rolled back.
In that case, you must rebuild the affected rollup buckets.

In Machbase, the currently documented rebuild paths are:

1. Python script
   - built-in rollup only
   - for standard rollup / rollup extension
   - rebuilds by time range (`begintime ~ endtime`)
   - uses the Machbase Neo REST API
2. Built-in server procedure `EXEC ROLLUP_REBUILD(...)`
   - supports built-in rollup, rollup extension, and custom rollup
   - callable directly from SQL
   - follows the custom rollup dependency tree for stop/rebuild/start

## Limitations

1. The Python rebuild tool is only for built-in rollups.
2. The Python rebuild tool only targets tables created with `WITH ROLLUP` or `WITH ROLLUP EXTENSION`.
3. The Python rebuild tool assumes internal built-in rollup tables (`_<table>_ROLLUP_SEC`, `_<table>_ROLLUP_MIN`, `_<table>_ROLLUP_HOUR`) and the fixed built-in aggregate schema.
4. Custom rollups cannot be recovered directly with the Python rebuild tool.
5. `EXEC ROLLUP_REBUILD(...)` is supported in Standard Edition and is **not supported in Cluster Edition**.
6. `EXEC ROLLUP_REBUILD(...)` only supports single-tag rebuild by `table_name`, `tag_name`, `begin_time`, and `end_time`.
7. The rebuild range must be handled as whole affected buckets, not partial timestamps, with delete followed by insert.

## Python-Based Rollup Rebuild

### Scope

The Python script is intended for built-in rollups only.

Assumptions:

- The source table uses `WITH ROLLUP` or `WITH ROLLUP EXTENSION`
- Internal rollup table names follow this pattern:
  - `_<table>_ROLLUP_SEC`
  - `_<table>_ROLLUP_MIN`
  - `_<table>_ROLLUP_HOUR`
- The internal aggregate columns follow the fixed built-in rollup schema
- Delete and reinsert can be done based on `_ID`

It cannot be applied directly to custom rollups because the destination table name, column count, types, and aggregate expressions are all user-defined.

### Example

```bash
python3 rollup_rebuild_timerange.py \
  --server http://127.0.0.1:5654 \
  --tablename TAG \
  --tagname tag-0 \
  --begintime '2000-01-01 00:00:00' \
  --endtime   '2000-01-01 00:00:11'
```

### Parameters

| Parameter | Description |
|---|---|
| `--server` | Machbase Neo REST API address (e.g. `http://127.0.0.1:5654`) |
| `--tablename` | TAG table name (case-sensitive) |
| `--tagname` | Tag key value of the anomalous data |
| `--begintime` | Start time of the error/deletion range |
| `--endtime` | End time of the error/deletion range |

### Execution Model

The script restores built-in rollups in this order:

1. source flush
2. freeze if needed
3. second rollup: force / stop / delete / insert / start / flush
4. minute rollup: force / stop / delete / insert / start / flush
5. hour rollup: force / stop / delete / insert / start
6. unfreeze if needed

If execution stops in the middle, rerunning is generally safe because it rebuilds the same buckets by delete-then-insert.

## `EXEC ROLLUP_REBUILD(...)` Procedure

### Syntax

```sql
EXEC ROLLUP_REBUILD(table_name, tag_name, begin_time, end_time);
```

### Example

```sql
EXEC ROLLUP_REBUILD(tag,
                    'tag-00045',
                    TO_DATE('2025-09-02 01:00:00'),
                    TO_DATE('2025-09-02 01:00:00'));

EXEC ROLLUP_REBUILD(sys.tag,
                    'tag-00045',
                    TO_DATE('2025-09-02 01:00:00'),
                    TO_DATE('2025-09-02 01:00:00'));
```

### Parameters

| Parameter | Description |
|---|---|
| `table_name` | Source TAG table name (use `schema.table` if needed) |
| `tag_name` | Target tag key value to rebuild |
| `begin_time` | Start time of the corrected range |
| `end_time` | End time of the corrected range |

### Coverage

- built-in rollup
- rollup extension
- custom rollup
- rollup-on-rollup dependency pipelines

## How Custom Rollup Rebuild Works

### Why fixed built-in SQL is not enough

In a custom rollup, all of the following are user-defined:

- destination table name
- destination column count and types
- aggregate functions
- whether the source is a root table or another rollup destination

So a generic rebuild cannot rely on a fixed schema reinsertion pattern.
It must rerun the original custom `SELECT` while restricting the rebuild to the affected tag/time buckets.

### Bucket Expansion

For example, suppose the anomalous source range for a 1-minute custom rollup is:

- source error time: `2026-01-27 09:30:12` ~ `2026-01-27 09:31:07`

The actual rebuild target must cover the whole buckets:

- start bucket: `2026-01-27 09:30:00`
- end bucket: `2026-01-27 09:31:59.999999999`

Always delete the target buckets first, then insert again. Partial aggregate rows may already exist.

### Manual Rebuild Procedure

1. Stop all affected custom rollups
2. Correct or reload the anomalous source data
3. Calculate bucket boundaries
4. Delete from the destination
5. Reinsert using the original aggregation logic from `CREATE ROLLUP ... AS (SELECT ...)`
6. Flush the destination
7. If upper-level custom rollups exist, repeat from the lower level upward
8. Start the rollups

## Manual Custom Rollup Rebuild Examples

### 1-minute custom rollup

```sql
STOP ROLLUP rollup_stock_1m;

DELETE FROM stock_rollup_1m
WHERE time BETWEEN TO_DATE('2026-01-27 09:30:00')
               AND TO_DATE('2026-01-27 09:31:59');

INSERT INTO stock_rollup_1m
SELECT code,
       DATE_TRUNC('minute', time) AS time,
       SUM(price)                 AS sum_price,
       SUM(volume)                AS sum_volume,
       COUNT(*)                   AS cnt
FROM stock_tick
WHERE time BETWEEN TO_DATE('2026-01-27 09:30:00')
               AND TO_DATE('2026-01-27 09:31:59')
GROUP BY code, time;

EXEC TABLE_FLUSH('stock_rollup_1m');
START ROLLUP rollup_stock_1m;
```

### Custom rollup with FIRST/LAST

```sql
STOP ROLLUP rollup_stock_candle_1m;

DELETE FROM stock_candle_1m
WHERE time = TO_DATE('2026-01-27 09:30:00');

INSERT INTO stock_candle_1m
SELECT code,
       DATE_TRUNC('minute', time) AS time,
       MIN(time)                  AS firsttime,
       MAX(time)                  AS lasttime,
       FIRST(time, price)         AS open,
       MAX(price)                 AS high,
       MIN(price)                 AS low,
       LAST(time, price)          AS close,
       SUM(volume)                AS volume,
       COUNT(*)                   AS cnt
FROM stock_tick
WHERE time BETWEEN TO_DATE('2026-01-27 09:30:00')
               AND TO_DATE('2026-01-27 09:30:59')
GROUP BY code, time;

EXEC TABLE_FLUSH('stock_candle_1m');
START ROLLUP rollup_stock_candle_1m;
```

### Rollup-on-rollup order

Example pipeline: `stock_tick -> stock_rollup_1m -> stock_rollup_1h`

The rebuild order must always start from the lower stage:

1. stop `stock_rollup_1h`
2. stop `stock_rollup_1m`
3. rebuild `stock_rollup_1m`
4. delete/rebuild `stock_rollup_1h`
5. start `stock_rollup_1m`
6. start `stock_rollup_1h`

If you rebuild the upper stage first, it will read lower-stage results that have not yet been restored, and incorrect aggregates will be written again.

## Efficient Rollup Queries Including Recent Data

Core pattern:

1. Use rollup tables for stable historical ranges
2. Aggregate directly from the source table for the recent range
3. Combine both with `UNION ALL`

### Standard 1-minute rollup example

```sql
SELECT ROLLUP('minute', 1, time) AS mtime, AVG(value)
FROM tag
WHERE name = 'TAG_0001'
  AND time < DATE_TRUNC('minute', SYSDATE) - 2m
GROUP BY mtime

UNION ALL

SELECT DATE_TRUNC('minute', time) AS mtime, AVG(value)
FROM tag
WHERE name = 'TAG_0001'
  AND time >= DATE_TRUNC('minute', SYSDATE) - 2m
GROUP BY mtime;
```

### Custom rollup example

```sql
SELECT code, time,
       SUM(sum_price) / SUM(cnt) AS avg_price
FROM (
      SELECT code, time,
             SUM(sum_price) AS sum_price,
             SUM(cnt)       AS cnt
      FROM stock_rollup_1m
      WHERE time < DATE_TRUNC('minute', SYSDATE) - 2m
      GROUP BY code, time

      UNION ALL

      SELECT code,
             DATE_TRUNC('minute', time) AS time,
             SUM(price)                 AS sum_price,
             COUNT(*)                   AS cnt
      FROM stock_tick
      WHERE time >= DATE_TRUNC('minute', SYSDATE) - 2m
      GROUP BY code, time
     )
GROUP BY code, time
ORDER BY code, time;
```

## Operational Recommendations

1. Confirm the affected bucket range before rebuilding custom rollups.
2. Check dependencies with `v$rollup` before and after operational changes.
3. If one error time range spans multiple buckets, rebuild every affected bucket.
4. Custom rollup destination tables accumulate append-only results, so rebuild must use delete followed by insert.
5. In rollup-on-rollup pipelines, always rebuild from lower stages first then upper stages.
6. For large built-in time-range recovery, the Python tool is more convenient. For custom or mixed extension/custom environments, use `EXEC ROLLUP_REBUILD(...)`.
