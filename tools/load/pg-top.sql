-- Top queries since the last pg_stat_statements_reset(), for a load run.
-- Needs shared_preload_libraries = 'pg_stat_statements' on the server.
\echo '== by total time'
SELECT round(total_exec_time::numeric, 0) AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(max_exec_time::numeric, 1) AS max_ms,
       rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
 ORDER BY total_exec_time DESC
 LIMIT 25;

\echo '== slowest mean (called at least 20 times)'
SELECT round(mean_exec_time::numeric, 2) AS mean_ms,
       calls,
       round(max_exec_time::numeric, 1) AS max_ms,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND calls >= 20
 ORDER BY mean_exec_time DESC
 LIMIT 15;

\echo '== sequential scans on big-ish tables'
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
  FROM pg_stat_user_tables
 WHERE seq_scan > 0 AND n_live_tup > 1000
 ORDER BY seq_tup_read DESC
 LIMIT 15;
